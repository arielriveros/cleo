import { describe, it, expect } from 'vitest';
import { AudioRecorder, buildAudioSchedule, keyValueAt, type RecordedSound } from '../src/audio/movieAudio';
import { DEFAULT_SOUND_SETTINGS, BUS_IDS } from '../src/audio/soundSettings';
import type { BusId, SoundSettings } from '../src/audio/soundSettings';

// A movie's sound is recorded as what was asked of the audio stack, against the movie's own clock, then
// mixed offline. The virtual voices must answer position and playing from that clock (the sequencer's
// audio track corrects drift against it), and the schedule must turn the log back into pieces and
// automation that play the same thing.

const buses = Object.fromEntries(BUS_IDS.map(b => [b, { gain: 1, muted: false }])) as Record<BusId, { gain: number; muted: boolean }>;

function sound(id: string, duration: number, settings: Partial<SoundSettings> = {}): RecordedSound {
    return { id, duration, settings: { ...DEFAULT_SOUND_SETTINGS, ...settings }, source: { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/wav' } };
}

function recorder() {
    const clock = { t: 0 };
    return { clock, rec: new AudioRecorder(() => clock.t, buses, 0.8) };
}

describe('virtual voices', () => {
    it('play on the movie clock: position, rate and the end of the sample', () => {
        const { clock, rec } = recorder();
        const s = sound('a', 10);
        clock.t = 1;
        const v = rec.play(s);
        clock.t = 2.5;
        expect(rec.seek(s, v)).toBeCloseTo(1.5, 9);
        expect(rec.isPlaying(s, v)).toBe(true);
        rec.setRate(v, 2);
        clock.t = 3.5;
        expect(rec.seek(s, v)).toBeCloseTo(3.5, 9);
        clock.t = 7;
        expect(rec.isPlaying(s, v)).toBe(false);
    });

    it('never drift from the clock, however long the frames between took', () => {
        const { clock, rec } = recorder();
        const s = sound('a', 100);
        const v = rec.play(s);
        rec.seekVoice(v, 12);
        // What the sequencer's audio track compares against its timeline each frame: offset + elapsed.
        for (let frame = 1; frame <= 300; frame++) {
            clock.t = frame / 60;
            expect(Math.abs(rec.seek(s, v) - (12 + frame / 60))).toBeLessThan(1e-9);
        }
    });

    it('wrap a loop region and pause in place', () => {
        const { clock, rec } = recorder();
        const s = sound('a', 10, { loop: true, loopStart: 2, loopEnd: 4 });
        const v = rec.play(s);
        expect(rec.seek(s, v)).toBe(2);
        clock.t = 3;
        expect(rec.seek(s, v)).toBeCloseTo(3, 9);
        expect(rec.isPlaying(s, v)).toBe(true);
        rec.pause(s, v);
        clock.t = 10;
        expect(rec.seek(s, v)).toBeCloseTo(3, 9);
        rec.resume(s, v);
        clock.t = 10.5;
        expect(rec.seek(s, v)).toBeCloseTo(3.5, 9);
    });

    it('sound on through a fade-out stop', () => {
        const { clock, rec } = recorder();
        const s = sound('a', 10, { fadeOut: 1 });
        const v = rec.play(s);
        clock.t = 2;
        rec.stop(s, v);
        clock.t = 2.5;
        expect(rec.isPlaying(s, v)).toBe(true);
        clock.t = 3.01;
        expect(rec.isPlaying(s, v)).toBe(false);
    });
});

describe('the schedule', () => {
    it('cuts a voice into constant-rate pieces that continue where the last one got to', () => {
        const { clock, rec } = recorder();
        const s = sound('a', 20);
        clock.t = 1;
        const v = rec.play(s);
        clock.t = 2; rec.setRate(v, 2);
        clock.t = 3; rec.pause(s, v);
        clock.t = 5; rec.resume(s, v);
        clock.t = 6; rec.seekVoice(v, 0.5);
        const plan = buildAudioSchedule(rec.finish(10)).voices[0];
        expect(plan.pieces.map(p => [p.t0, p.t1, Number(p.offset.toFixed(6)), p.rate])).toEqual([
            [1, 2, 0, 1],
            [2, 3, 1, 2],
            [5, 6, 3, 2],
            [6, Infinity, 0.5, 2],
        ]);
    });

    it('keys gain as howler plays it: fades ramp, a value set mid-fade ends the fade, a fade-out stop ramps to 0', () => {
        const { clock, rec } = recorder();
        const s = sound('a', 20, { fadeOut: 0.5 });
        const v = rec.play(s);
        clock.t = 1; rec.fade(s, 1, 0, 2, v);
        clock.t = 2; rec.setVolume(v, 0.7);
        clock.t = 4; rec.stop(s, v);
        const plan = buildAudioSchedule(rec.finish(10)).voices[0];
        expect(keyValueAt(plan.gain, 0.5, 0)).toBe(1);
        expect(keyValueAt(plan.gain, 1.5, 0)).toBeCloseTo(0.75, 9);
        expect(keyValueAt(plan.gain, 2.5, 0)).toBe(0.7);
        expect(keyValueAt(plan.gain, 4.25, 0)).toBeCloseTo(0.35, 9);
        expect(keyValueAt(plan.gain, 5, 0)).toBe(0);
        expect(plan.pieces[plan.pieces.length - 1].t1).toBeCloseTo(4.5, 9);
    });

    it('times everything from the first frame, a pre-roll landing before zero', () => {
        const { clock, rec } = recorder();
        const s = sound('a', 20);
        clock.t = 0.25;
        rec.play(s);
        clock.t = 1;
        rec.listener([1, 2, 3], [0, 0, -1], [0, 1, 0]);
        const log = rec.finish(5, 0.5);
        expect(log.ops[0].t).toBeCloseTo(-0.25, 9);
        const schedule = buildAudioSchedule(log);
        expect(schedule.voices[0].pieces[0].t0).toBeCloseTo(-0.25, 9);
        expect(schedule.listener[0][0]).toEqual({ t: 0.5, v: 1, ramp: false });
        expect(schedule.master[0].v).toBe(0.8);
        expect(log.sounds.a.duration).toBe(20);
    });

    it('makes a voice spatial once it is placed, ramping between the frames it moved in', () => {
        const { clock, rec } = recorder();
        const s = sound('a', 20);
        const v = rec.play(s);
        rec.setPosition(v, 0, 0, 0);
        clock.t = 1;
        rec.setPosition(v, 10, 0, 0);
        const plan = buildAudioSchedule(rec.finish(5)).voices[0];
        expect(plan.spatial).not.toBeNull();
        expect(keyValueAt(plan.position[0], 0.5, 0)).toBeCloseTo(5, 9);
    });
});
