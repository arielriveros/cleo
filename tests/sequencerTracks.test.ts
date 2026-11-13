import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Scene } from '../src/core/scene/scene';
import { SequenceNode } from '../src/core/scene/nodes/sequenceNode';
import { SequencePlayer, type SequencePlayerHost } from '../src/sequencer/sequencePlayer';
import { parseSequence } from '../src/sequencer/parse';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { SequenceData, SequenceScriptContext } from '../src/sequencer/types';

// The tracks M4 added: script sections (and their holds), animation, audio, spawn and possession. Script and
// hold go through a SequenceNode in a Scene, as a game plays them; the rest through the player against plain
// objects standing in for the engine's (the player only calls their public surface), and the animation track
// against a real Animator.

const DT = 1 / 60;

function sequence(partial: Partial<SequenceData>): SequenceData {
    return parseSequence({ version: 1, name: 'Test', duration: 10, fps: 30, clock: 'game', loop: false,
                           slots: [], tracks: [], markers: [], ...partial });
}

function run(scene: Scene, seconds: number): void {
    const frames = Math.round(seconds / DT);
    for (let i = 0; i < frames; i++) scene.update(DT, 0, false);
}

/** A player over `seq` whose slots are `slots`, with a mock scene that can instantiate. */
function playerOf(seq: SequenceData, slots: Record<string, any>, extra: Partial<SequencePlayerHost> = {}) {
    const overrides = new Map<string, any>();
    const host: SequencePlayerHost = {
        resolveSlot: (id: string) => overrides.get(id) ?? slots[id] ?? null,
        director: null, scene: null,
        setSlotOverride: (id, node) => { if (node) overrides.set(id, node); else overrides.delete(id); },
        ...extra,
    };
    return { player: new SequencePlayer(seq, host), overrides };
}

describe('script sections', () => {
    function scriptScene(tracks: any[], duration = 6) {
        const scene = new Scene();
        const calls: { phase: string, method: string, ctx: SequenceScriptContext }[] = [];
        const director = new SequenceNode('Seq', { sequence: sequence({ duration, tracks } as any) });
        for (const m of ['flash', 'blink', 'gate'])
            (director as any)[m] = (ctx: SequenceScriptContext) => calls.push({ phase: ctx.phase, method: m, ctx: { ...ctx } });
        scene.addNode(director);
        scene.start();
        return { scene, director, calls };
    }

    it('enters once, updates each frame inside, and exits as playback leaves', () => {
        const { scene, director, calls } = scriptScene([
            { id: 's', type: 'script', sections: [{ id: 'f', start: 1, end: 2, method: 'flash', args: [3], easeIn: 0.5 }] },
        ]);
        director.play();
        run(scene, 3);
        const phases = calls.map(c => c.phase);
        expect(phases[0]).toBe('enter');
        expect(phases[phases.length - 1]).toBe('exit');
        expect(phases.filter(p => p === 'update').length).toBeGreaterThan(50);
        expect(phases.filter(p => p === 'enter').length).toBe(1);
        const mid = calls.find(c => c.phase === 'update' && c.ctx.local > 0.2 && c.ctx.local < 0.3)!;
        expect(mid.ctx.args).toEqual([3]);
        expect(mid.ctx.dt).toBeCloseTo(DT, 6);
        expect(mid.ctx.seeking).toBe(false);
        // Half way through its 0.5 s ease-in.
        expect(calls.find(c => c.ctx.local >= 0.25)!.ctx.weight).toBeGreaterThan(0.4);
        expect(calls[calls.length - 1].ctx.stopped).toBe(false);
    });

    it('runs a section passed inside one frame, skips one jumped over, and exits on stop', () => {
        const { scene, director, calls } = scriptScene([
            { id: 's', type: 'script', sections: [
                { id: 'a', start: 0.5, end: 0.51, method: 'blink' },
                { id: 'b', start: 3, end: 3.01, method: 'blink' },
                { id: 'c', start: 4, end: 6, method: 'flash' },
            ] },
        ]);
        director.play();
        scene.update(1, 0, false);
        expect(calls.map(c => `${c.method}:${c.phase}`)).toEqual(['blink:enter', 'blink:exit']);
        calls.length = 0;
        director.seek(5);
        // The seek lands inside 'c' and over 'b', which never runs.
        expect(calls.map(c => `${c.method}:${c.phase}:${c.ctx.seeking}`)).toEqual(['flash:enter:true']);
        calls.length = 0;
        director.stop();
        expect(calls.map(c => `${c.method}:${c.phase}:${c.ctx.stopped}`)).toEqual(['flash:exit:true']);
    });

    it('holds at a hold section until the method calls ctx.resume(), or resume() is called', () => {
        let release: (() => void) | null = null;
        const { scene, director } = scriptScene([
            { id: 's', type: 'script', sections: [
                { id: 'h1', start: 1, end: 2, method: 'gate', hold: true },
                { id: 'h2', start: 3, end: 4, method: 'gate', hold: true },
            ] },
        ]);
        let waiting = 0;
        (director as any).gate = (ctx: SequenceScriptContext) => {
            if (ctx.phase === 'enter') release = ctx.resume;
            // Still called while the playback waits at the end, so it can poll what it waits on.
            if (ctx.phase === 'update' && ctx.local === ctx.duration) waiting++;
        };
        director.play();
        run(scene, 3);
        expect(director.time).toBe(2);
        expect(director.isHolding).toBe(true);
        expect(waiting).toBeGreaterThan(30);
        release!();
        expect(director.isHolding).toBe(false);
        run(scene, 1.5);
        expect(director.time).toBeCloseTo(3.5, 5);
        run(scene, 2);
        expect(director.time).toBe(4);
        director.resume();
        run(scene, 1);
        expect(director.time).toBeCloseTo(5, 5);
    });

    it('parses back what it serializes', () => {
        const seq = sequence({ tracks: [
            { id: 's', type: 'script', slot: 'door', sections: [{ id: 'x', start: 1, end: 2, method: 'open', args: [1, 'a'], hold: true }] },
            { id: 'a', type: 'animation', slot: 'hero', animSlot: 'Upper', sections: [{ id: 'y', start: 0, end: 3, clip: 'Wave', clipStart: 0.5, speed: 2, loop: true }] },
            { id: 'u', type: 'audio', slot: 'music', sections: [{ id: 'z', start: 0, end: 5, offset: 2, volume: { keys: [{ t: 0, v: 0.5 }] } }] },
            { id: 'p', type: 'spawn', sections: [{ id: 'w', start: 1, end: 4, template: 'Splash', position: [1, 2, 3], bindAs: 'fx' }] },
            { id: 'o', type: 'possess', slot: 'ctl', sections: [{ id: 'v', start: 0, end: 1, pawn: 'hero' }] },
            { id: 'bad', type: 'script', sections: [{ id: 'q', start: 0, end: 1 }] },
        ] } as any);
        expect(parseSequence(JSON.parse(JSON.stringify(seq)))).toEqual(seq);
        expect(seq.tracks.map(t => t.type)).toEqual(['script', 'animation', 'audio', 'spawn', 'possess', 'script']);
        expect((seq.tracks[5] as any).sections).toEqual([]);
    });
});

// ---- animation: the two-bone chain of animatorLayers.test.ts ------------------------------------------------

const SKIN: Skin = {
    joints: [
        { nodeIndex: 0, inverseBindMatrix: mat4.create() },
        { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 },
    ],
    nodeParents: new Map([[1, 0]]),
    nodeTransforms: new Map([[0, mat4.create()], [1, mat4.create()]]),
    nodeNames: new Map([[0, 'Hips'], [1, 'Spine']]),
};
const qy = (deg: number) => quat.setAxisAngle(quat.create(), [0, 1, 0], deg * Math.PI / 180);
function clip(name: string, fromDeg: number, toDeg: number, duration = 1): Animation {
    const a = qy(fromDeg), b = qy(toDeg);
    const out = [a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]];
    return {
        name,
        samplers: [{ input: [0, duration], output: out.slice(), interpolation: 'LINEAR' }, { input: [0, duration], output: out.slice(), interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' }, { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' }],
    } as Animation;
}
function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    return new Animator({ skin: SKIN, animations: [clip('Idle', 0, 0), clip('Wave', 0, 90, 2)] } as unknown as AnimatedModel, node as any);
}

describe('animation track', () => {
    const seq = sequence({ tracks: [{ id: 'a', type: 'animation', slot: 'hero',
        sections: [{ id: 'w', start: 1, end: 3, clip: 'Wave', clipStart: 0.25, easeIn: 0.1, easeOut: 0.3 }] }] } as any);

    it('plays the clip as an action on the slot\'s animator, on the timeline\'s clock, and stops it on leaving', () => {
        const animator = makeAnimator();
        // The animator is found on a child, as on a character whose model carries it.
        const hero = { children: [{ animator, children: [] }] };
        const { player } = playerOf(seq, { hero });
        const handles: any[] = [];
        const play = animator.playAction.bind(animator);
        animator.playAction = (name, options) => { const h = play(name, options); handles.push({ h, options }); return h; };

        player.evaluate(0.5, 0.4);
        expect(handles.length).toBe(0);
        player.evaluate(1.5, 1.49);
        expect(handles.length).toBe(1);
        expect(handles[0].options).toMatchObject({ slot: 'Sequence', blendIn: 0.1, blendOut: 0.3, startTime: 0.75 });
        expect(animator.lodExempt).toBe(true);
        expect(animator.isActionPlaying('Sequence')).toBe(true);
        // A seek puts the clip exactly where the timeline is, without restarting it.
        player.evaluate(2.4);
        expect(handles.length).toBe(1);
        expect(handles[0].h.time).toBeCloseTo(1.65, 6);
        expect(handles[0].h.duration).toBeCloseTo(2, 6);
        // Leaving fades it out and gives the animator its LOD back.
        player.evaluate(3.5, 3.4);
        for (let i = 0; i < 30; i++) animator.update(DT);
        expect(handles[0].h.done).toBe(true);
        expect(animator.lodExempt).toBe(false);
    });

    it('keeps a played clip on the timeline past a tenth of a second of drift only', () => {
        const animator = makeAnimator();
        const { player } = playerOf(seq, { hero: { animator } });
        player.evaluate(1.0, 0.99);
        let seeks = 0;
        // Play on without the animator ticking: the clip lags the timeline, and a seek catches it up.
        const h = (player as any)._states.get('a').anim;
        const seek = h.seek; h.seek = (t: number) => { seeks++; seek(t); };
        player.evaluate(1.05, 1.0);
        expect(seeks).toBe(0);
        player.evaluate(1.2, 1.05);
        expect(seeks).toBe(1);
        expect(h.time).toBeCloseTo(0.45, 6);
    });

    it('stops the action on a stop', () => {
        const animator = makeAnimator();
        const { player } = playerOf(seq, { hero: { animator } });
        player.evaluate(2, 1.9);
        player.restoreAll();
        for (let i = 0; i < 30; i++) animator.update(DT);
        expect(animator.isActionPlaying('Sequence')).toBe(false);
        expect(animator.lodExempt).toBe(false);
    });
});

// ---- audio --------------------------------------------------------------------------------------------------

function mockSound(duration = 30) {
    const log: string[] = [];
    const s = {
        gain: 1, playbackRate: 1, duration, isPlaying: false, playhead: 0,
        play(options: { offset?: number } = {}) { s.isPlaying = true; s.playhead = options.offset ?? 0; log.push(`play ${s.playhead.toFixed(2)}`); },
        stop() { s.isPlaying = false; log.push('stop'); },
        seek(t: number) { s.playhead = t; log.push(`seek ${t.toFixed(2)}`); },
    };
    return { s, log };
}

describe('audio track', () => {
    const seq = sequence({ tracks: [{ id: 'u', type: 'audio', slot: 'music',
        sections: [{ id: 'm', start: 2, end: 6, offset: 1, easeIn: 1, volume: { keys: [{ t: 0, v: 0.5 }] } }] }] } as any);

    it('starts at the offset the timeline is at, fades by the eases and the volume, follows the speed, and stops', () => {
        const { s, log } = mockSound();
        const { player } = playerOf(seq, { music: s }, { playbackRate: 2 });
        player.evaluate(2.5, 2.49);
        expect(log).toEqual(['play 1.50']);
        expect(s.playbackRate).toBe(2);
        expect(s.gain).toBeCloseTo(0.5 * 0.5, 5);
        // Playing along: no correction while it keeps up, a seek once it is a fifth of a second off.
        s.playhead = 1.6;
        player.evaluate(2.6, 2.5);
        s.playhead = 1.7;
        player.evaluate(3.0, 2.6);
        expect(log).toEqual(['play 1.50', 'seek 2.00']);
        expect(s.gain).toBeCloseTo(0.5, 5);
        // A scrub seeks it straight there.
        player.evaluate(4.0);
        expect(log[log.length - 1]).toBe('seek 3.00');
        player.evaluate(6.5, 6.4);
        expect(log[log.length - 1]).toBe('stop');
        expect(s.gain).toBe(1);
        expect(s.playbackRate).toBe(1);
    });

    it('stays silent past a one-shot\'s end', () => {
        const { s, log } = mockSound(1);
        const { player } = playerOf(seq, { music: s });
        player.evaluate(4);
        expect(log).toEqual([]);
    });
});

// ---- spawn and possession -----------------------------------------------------------------------------------

function mockScene() {
    const made: any[] = [];
    const scene: any = {
        instantiate(template: string, options: any) {
            if (template !== 'Splash') return null;
            const node: any = { template, options, scene, removed: false, remove() { node.removed = true; node.scene = null; } };
            made.push(node);
            return node;
        },
    };
    return { scene, made };
}

describe('spawn track', () => {
    const seq = sequence({ tracks: [{ id: 'p', type: 'spawn', sections: [
        { id: 'a', start: 1, end: 3, template: 'Splash', position: [1, 0, 2], bindAs: 'fx' },
        { id: 'b', start: 2, end: 2.5, template: 'Splash', whenFinished: 'keep' },
        { id: 'c', start: 4, end: 5, template: 'Missing' },
    ] }] } as any);

    it('instantiates while a section is in, binds it, removes it after (unless kept), and on a stop', () => {
        const { scene, made } = mockScene();
        const { player, overrides } = playerOf(seq, {}, { scene });
        player.evaluate(1.5, 1.4);
        expect(made.length).toBe(1);
        expect(made[0].options).toEqual({ position: [1, 0, 2] });
        expect(overrides.get('fx')).toBe(made[0]);
        player.evaluate(2.2, 2.1);
        expect(made.length).toBe(2);
        player.evaluate(2.8, 2.7);
        // Kept: left in the scene.
        expect(made[1].removed).toBe(false);
        player.evaluate(3.2, 3.1);
        expect(made[0].removed).toBe(true);
        expect(overrides.has('fx')).toBe(false);
        player.evaluate(4.5, 4.4);
        expect(made.length).toBe(2);
        // A seek back in spawns it again; a stop removes it.
        player.evaluate(1.2);
        expect(made.length).toBe(3);
        player.restoreAll();
        expect(made[2].removed).toBe(true);
        expect(made[1].removed).toBe(false);
    });

    it('spawns nothing while the editor previews', () => {
        const { scene, made } = mockScene();
        const { player } = playerOf(seq, {}, { scene, authoring: true });
        player.evaluate(1.5);
        expect(made.length).toBe(0);
    });
});

describe('possess track', () => {
    it('possesses the pawn over the section and gives the controller back what it had', () => {
        const before = { name: 'player' }, hero = { name: 'hero' };
        const controller: any = { possessed: before, possess(p: any) { controller.possessed = p; return controller; },
                                  release() { controller.possessed = null; return controller; } };
        const seq = sequence({ tracks: [{ id: 'o', type: 'possess', slot: 'ctl', sections: [{ id: 's', start: 1, end: 2, pawn: 'hero' }] }] } as any);
        const { player } = playerOf(seq, { ctl: controller, hero });
        player.evaluate(1.5, 1.4);
        expect(controller.possessed).toBe(hero);
        player.evaluate(2.5, 2.4);
        expect(controller.possessed).toBe(before);
        player.evaluate(1.5);
        player.restoreAll();
        expect(controller.possessed).toBe(before);
    });
});
