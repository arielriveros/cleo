import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vec3 } from 'gl-matrix';
import { SoundNode } from '../src/core/scene/nodes/soundNode';
import { AudioManager } from '../src/audio/audioManager';
import { loudnessEnvelope, ENVELOPE_WINDOW } from '../src/audio/sound';

/**
 * A Sound node's overlap: how many of its plays sound at once (`voices`), which one a play takes over when they are
 * all busy (`whenFull`), where a spatial voice sounds (`voicesStayPut`), the random pitch and volume per play, and the
 * retrigger guard. Run against a fake sample that keeps its voices in a map, so it is howler-free: the node only ever
 * talks to its sample through the per-voice calls, which is what is pinned here.
 */

interface FakeVoice { alive: boolean; playing: boolean; volume: number; rate: number; level: number; position?: number[] }

class FakeSample {
    public settings = { volume: 1, pan: 0 };
    public duration = 4.5;
    public voices = new Map<number, FakeVoice>();
    public log: unknown[][] = [];
    private _next = 1;
    play(): number { const id = this._next++; this.voices.set(id, { alive: true, playing: true, volume: 1, rate: 1, level: 1 }); this.log.push(['play', id]); return id; }
    stop(id: number): void { this._end(id); this.log.push(['stop', id]); }
    stopVoice(id: number, seconds: number): void { this._end(id); this.log.push(['steal', id, seconds]); }
    pause(id: number): void { const v = this.voices.get(id); if (v) v.playing = false; this.log.push(['pause', id]); }
    resume(id: number): number { const v = this.voices.get(id); if (v) v.playing = true; this.log.push(['resume', id]); return id; }
    isPlaying(id: number): boolean { return !!this.voices.get(id)?.playing; }
    voiceAlive(id: number): boolean { return !!this.voices.get(id)?.alive; }
    voiceLevel(id: number): number { const v = this.voices.get(id); return v ? v.level * v.volume : 0; }
    /** Each voice's playhead is its id times ten: which voice `playhead` read is plain. */
    seek(id: number): number { return id * 10; }
    seekVoice(id: number, seconds: number): void { this.log.push(['seek', id, seconds]); }
    setVoiceLoop(): void {}
    setVoiceVolume(id: number, volume: number): void { const v = this.voices.get(id); if (v) v.volume = volume; }
    setVoiceRate(id: number, rate: number): void { const v = this.voices.get(id); if (v) v.rate = rate; }
    setVoicePan(): void {}
    setVoicePosition(id: number, x: number, y: number, z: number): void { const v = this.voices.get(id); if (v) v.position = [x, y, z]; }
    setVoiceSpatial(): void {}
    fade(from: number, to: number, seconds: number, id: number): void { this.log.push(['fade', id, from, to, seconds]); }
    private _end(id: number): void { const v = this.voices.get(id); if (v) { v.alive = false; v.playing = false; } }
    ops(kind: string): unknown[][] { return this.log.filter(e => e[0] === kind); }
}

let sample: FakeSample;
let now = 0;
const listener = vec3.create();

beforeEach(() => {
    sample = new FakeSample();
    now = 0;
    vec3.set(listener, 0, 0, 0);
    vi.spyOn(AudioManager.Instance, 'getSound').mockImplementation(((id: string) => (id === 's' ? sample : undefined)) as any);
    vi.spyOn(AudioManager.Instance, 'listenerPosition', 'get').mockImplementation(() => listener);
    vi.spyOn(performance, 'now').mockImplementation(() => now * 1000);
});
afterEach(() => vi.restoreAllMocks());

const emitter = (options: ConstructorParameters<typeof SoundNode>[1] = {}) => new SoundNode('Shot', { sampleId: 's', ...options });

describe('Sound node voices', () => {
    it('restarts with one voice, as it always has', () => {
        const node = emitter();
        node.play();
        node.play();
        expect(sample.ops('stop')).toEqual([['stop', 1]]);
        expect(node.activeVoices).toBe(1);
        expect(node.isPlaying).toBe(true);
    });

    it('rings several plays at once, then steals the oldest with a short ramp', () => {
        const node = emitter({ voices: 3 });
        for (let i = 0; i < 3; i++) node.play();
        expect(node.activeVoices).toBe(3);
        expect(sample.ops('stop')).toEqual([]);
        node.play();
        expect(sample.ops('steal')).toEqual([['steal', 1, 0.03]]);
        expect(node.activeVoices).toBe(3);
        // A voice that ended on its own frees its place: no steal.
        sample.voices.get(2)!.alive = false;
        node.play();
        expect(sample.ops('steal')).toHaveLength(1);
    });

    it('steals the quietest voice when told to, the oldest on a tie', () => {
        const node = emitter({ voices: 3, whenFull: 'quietest' });
        for (let i = 0; i < 3; i++) node.play();
        sample.voices.get(2)!.level = 0.2;
        node.play();
        expect(sample.ops('steal')).toEqual([['steal', 2, 0.03]]);
        // 1, 3 and 4 all at level 1: the oldest goes.
        node.play();
        expect(sample.ops('steal')[1]).toEqual(['steal', 1, 0.03]);
    });

    it('steals the farthest voice from the listener when its voices stay where they were played', () => {
        const node = emitter({ voices: 3, whenFull: 'farthest', voicesStayPut: true });
        for (const x of [5, 20, 10]) { node.setPosition([x, 0, 0]); node.updateTransforms(); node.play(); }
        expect(sample.voices.get(2)!.position).toEqual([20, 0, 0]);
        // Stay-put voices are not moved with the node.
        node.setPosition([0, 0, 0]); node.updateTransforms();
        node.syncSpatial();
        expect(sample.voices.get(2)!.position).toEqual([20, 0, 0]);
        node.play();
        expect(sample.ops('steal')).toEqual([['steal', 2, 0.03]]);
    });

    it('falls back to the oldest for farthest while the voices follow the node (all as far away)', () => {
        const node = emitter({ voices: 2, whenFull: 'farthest' });
        node.setPosition([5, 0, 0]); node.updateTransforms(); node.play();
        node.setPosition([50, 0, 0]); node.updateTransforms(); node.play();
        node.syncSpatial();
        expect(sample.voices.get(1)!.position).toEqual([50, 0, 0]);
        node.play();
        expect(sample.ops('steal')).toEqual([['steal', 1, 0.03]]);
    });

    it('drops the new play when full and told to skip', () => {
        const node = emitter({ voices: 2, whenFull: 'skip' });
        for (let i = 0; i < 3; i++) node.play();
        expect(sample.ops('play')).toHaveLength(2);
        expect(sample.ops('steal')).toEqual([]);
    });

    it('ignores a play sooner than the retrigger time after the last, except a restart', () => {
        const node = emitter({ voices: 4, retrigger: 0.1 });
        node.play();
        now = 0.05;
        node.play();
        expect(sample.ops('play')).toHaveLength(1);
        now = 0.12;
        node.play();
        expect(sample.ops('play')).toHaveLength(2);
        now = 0.13;
        node.play({ restart: true });
        expect(sample.ops('play')).toHaveLength(3);
        // A restart stops every voice for the new one.
        expect(node.activeVoices).toBe(1);
    });

    it('draws each play a pitch within ± the variation and a volume no louder than authored', () => {
        const node = emitter({ voices: 4, pitchVariation: 12, volumeVariation: 0.5, volume: 0.8 });
        const random = vi.spyOn(Math, 'random');
        random.mockReturnValue(1);
        node.play();
        expect(sample.voices.get(1)!.rate).toBeCloseTo(2, 5);
        expect(sample.voices.get(1)!.volume).toBeCloseTo(0.4, 5);
        random.mockReturnValue(0);
        node.play();
        expect(sample.voices.get(2)!.rate).toBeCloseTo(0.5, 5);
        expect(sample.voices.get(2)!.volume).toBeCloseTo(0.8, 5);
        random.mockReturnValue(1);
        node.play({ vary: false });
        expect(sample.voices.get(3)!.rate).toBe(1);
        expect(sample.voices.get(3)!.volume).toBeCloseTo(0.8, 5);
    });

    it('stops, pauses, fades and turns down every voice, and reads and seeks the newest', () => {
        const node = emitter({ voices: 3 });
        for (let i = 0; i < 3; i++) node.play();
        expect(node.playhead).toBe(30);
        node.seek(1.5);
        expect(sample.ops('seek')).toEqual([['seek', 3, 1.5]]);
        node.gain = 0.5;
        expect([...sample.voices.values()].map(v => v.volume)).toEqual([0.5, 0.5, 0.5]);
        // The authored volume keeps the sequence's gain (it used to drop it).
        node.volume = 0.5;
        expect([...sample.voices.values()].map(v => v.volume)).toEqual([0.25, 0.25, 0.25]);
        node.fadeTo(0, 1);
        expect(sample.ops('fade').map(e => e[1])).toEqual([1, 2, 3]);
        node.pause();
        expect(node.isPlaying).toBe(false);
        expect(node.activeVoices).toBe(3);
        node.resume();
        expect(node.isPlaying).toBe(true);
        node.stop();
        expect(sample.ops('stop').map(e => e[1])).toEqual([1, 2, 3]);
        expect(node.activeVoices).toBe(0);
    });

    it('lets the voices sounding finish when lowered, and keeps to the new count from the next play', () => {
        const node = emitter({ voices: 4 });
        for (let i = 0; i < 4; i++) node.play();
        node.voices = 2;
        expect(node.activeVoices).toBe(4);
        node.play();
        expect(sample.ops('steal').map(e => e[1])).toEqual([1, 2, 3]);
        expect(node.activeVoices).toBe(2);
    });
});

describe('loudnessEnvelope', () => {
    it('is the peak of every channel per window', () => {
        const rate = 1000;
        const window = Math.round(rate * ENVELOPE_WINDOW);
        const left = new Float32Array(window * 3);
        const right = new Float32Array(window * 3);
        left[1] = 0.9;
        right[window + 2] = -0.6;
        left[window * 2 + 5] = 0.1;
        expect(Array.from(loudnessEnvelope([left, right], rate)).map(v => +v.toFixed(3))).toEqual([0.9, 0.6, 0.1]);
    });
});
