import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { AnimatedSpriteNode } from '../src/core/scene/nodes/animatedSpriteNode';
import { CharacterBody2DNode } from '../src/core/scene/nodes/characterBody2DNode';
import { Area2DNode } from '../src/core/scene/nodes/area2DNode';
import { Sprite } from '../src/graphics/sprite';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { createConditionContext } from '../src/core/conditions';
import {
    advanceClip, clipLength, createPlayhead, normalizedTime, parseSpriteAnimationSet, stepSpriteMachine,
} from '../src/animation/spriteAnimation';
import type { SpriteAnimationSet, SpriteClip } from '../src/animation/spriteAnimation';

// Sprite clips: named clips with per-frame times, events and hitboxes, ping-pong and once, and the state
// machine that picks them from a 2D body's state and from triggers.

const clip = (o: Partial<SpriteClip> = {}): SpriteClip => ({
    name: 'run', fps: 10, loop: 'loop', frames: [{ tile: 0 }, { tile: 1 }, { tile: 2 }, { tile: 3 }], ...o,
});

describe('advanceClip', () => {
    it('steps frame by frame at the clip rate, and loops', () => {
        const c = clip(), h = createPlayhead(), entered: number[] = [];
        advanceClip(c, h, 0.25, entered);
        expect(h.frame).toBe(2);
        expect(entered).toEqual([1, 2]);
        advanceClip(c, h, 0.2, entered);
        expect(h.frame).toBe(0);
        expect(entered).toEqual([1, 2, 3, 0]);
    });

    it('holds per-frame durations', () => {
        const c = clip({ frames: [{ tile: 0, duration: 0.5 }, { tile: 1 }] });
        const h = createPlayhead(), entered: number[] = [];
        advanceClip(c, h, 0.4, entered);
        expect(h.frame).toBe(0);
        advanceClip(c, h, 0.15, entered);
        expect(h.frame).toBe(1);
        expect(clipLength(c)).toBeCloseTo(0.6, 9);
    });

    it('enters every frame a long step crosses, once each', () => {
        const c = clip({ loop: 'once', frames: [{ tile: 0 }, { tile: 1 }, { tile: 2 }, { tile: 3 }, { tile: 4 }] });
        const h = createPlayhead(), entered: number[] = [];
        advanceClip(c, h, 10, entered);
        expect(entered).toEqual([1, 2, 3, 4]);
        expect(h.finished).toBe(true);
        expect(h.frame).toBe(4);
        expect(normalizedTime(c, h)).toBe(1);
    });

    it('plays a ping-pong clip there and back', () => {
        const c = clip({ loop: 'pingpong', frames: [{ tile: 0 }, { tile: 1 }, { tile: 2 }] });
        const h = createPlayhead(), entered: number[] = [];
        advanceClip(c, h, 0.45, entered);
        expect(entered).toEqual([1, 2, 1, 0]);
    });
});

describe('stepSpriteMachine', () => {
    const machine = {
        entry: 'idle',
        states: [{ name: 'idle', clip: 'idle' }, { name: 'run', clip: 'run' }, { name: 'attack', clip: 'attack' }, { name: 'fall', clip: 'fall' }],
        transitions: [
            { from: 'idle', to: 'run', condition: { param: 'speedX', op: 'gt' as const, value: 0.5 } },
            { from: 'run', to: 'idle', condition: { param: 'speedX', op: 'lt' as const, value: 0.5 } },
            { from: 'attack', to: 'idle', exitTime: 1 },
            { from: '*', to: 'attack', condition: { param: 'attack', op: 'trigger' as const } },
            { from: '*', to: 'fall', condition: { op: 'and' as const, children: [
                { param: 'grounded', op: 'false' as const }, { param: 'velocityY', op: 'lt' as const, value: 0 }] } },
        ],
    };

    it('takes the first transition out of the state whose condition holds', () => {
        const ctx = createConditionContext();
        ctx.values.set('speedX', 3); ctx.values.set('grounded', true);
        expect(stepSpriteMachine(machine, 'idle', 0, ctx)).toBe('run');
        ctx.values.set('speedX', 0);
        expect(stepSpriteMachine(machine, 'run', 0, ctx)).toBe('idle');
        expect(stepSpriteMachine(machine, 'idle', 0, ctx)).toBeNull();
    });

    it('fires an any-state transition on a trigger, and lowers it', () => {
        const ctx = createConditionContext();
        ctx.values.set('grounded', true);
        ctx.values.set('attack', true);
        expect(stepSpriteMachine(machine, 'run', 0, ctx)).toBe('attack');
        expect(ctx.values.get('attack')).toBe(false);
    });

    it('waits for the exit time', () => {
        const ctx = createConditionContext();
        ctx.values.set('grounded', true);
        expect(stepSpriteMachine(machine, 'attack', 0.6, ctx)).toBeNull();
        expect(stepSpriteMachine(machine, 'attack', 1, ctx)).toBe('idle');
    });

    it('reads a compound condition', () => {
        const ctx = createConditionContext();
        ctx.values.set('grounded', false); ctx.values.set('velocityY', -2);
        expect(stepSpriteMachine(machine, 'run', 0, ctx)).toBe('fall');
    });
});

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

const SET: SpriteAnimationSet = {
    id: 'warrior', name: 'Warrior', defaultClip: 'idle',
    clips: [
        { name: 'idle', fps: 8, loop: 'loop', pivot: [0.5, 0.35], frames: [{ tile: 0 }, { tile: 1 }] },
        { name: 'run', fps: 10, loop: 'loop', frames: [{ tile: 10 }, { tile: 11 }, { tile: 12, events: ['step'] }] },
        { name: 'attack', fps: 12, loop: 'once', next: 'idle', frames: [
            { tile: 20 }, { tile: 21, events: ['swing'], hitboxes: [{ area: 'Sword', rect: [1, 1, 1.2, 0.8] }] }, { tile: 22 }] },
    ],
};

function warrior(withMachine = false) {
    const scene = new Scene();
    const ts = new Tileset({ id: 'w', textureId: 'w.png', imageWidth: 30, imageHeight: 30, tileWidth: 1, tileHeight: 1, columns: 30, rows: 30 });
    const body = new CharacterBody2DNode('Warrior');
    body.playerInput = false;
    const sword = new Area2DNode('Sword', [0.5, 0.5]);
    body.addChild(sword);
    const sprite = new AnimatedSpriteNode('Sprite', new Sprite({ tileset: ts }), { constraints: 'free' });
    const set: SpriteAnimationSet = withMachine ? {
        ...SET,
        machine: {
            entry: 'idle',
            states: [{ name: 'idle', clip: 'idle' }, { name: 'run', clip: 'run' }, { name: 'attack', clip: 'attack' }],
            transitions: [
                { from: 'idle', to: 'run', condition: { param: 'speedX', op: 'gt', value: 0.5 } },
                { from: 'run', to: 'idle', condition: { param: 'speedX', op: 'lt', value: 0.5 } },
                { from: '*', to: 'attack', condition: { param: 'attack', op: 'trigger' } },
                { from: 'attack', to: 'idle', exitTime: 1 },
            ],
        },
    } : SET;
    sprite.animationSet = set;
    body.addChild(sprite);
    scene.addNode(body);
    scene.start();
    return { scene, body, sprite, sword };
}
const run = (scene: Scene, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) scene.update(1 / 60, 0, false); };

describe('AnimatedSpriteNode clips', () => {
    it('plays clips by name, showing their tiles, with the clip pivot', () => {
        const { sprite } = warrior();
        expect(sprite.clip).toBe('idle');
        expect(sprite.currentTile).toBe(0);
        expect(sprite.sprite.pivot).toEqual([0.5, 0.35]);
        sprite.play('run');
        expect(sprite.currentTile).toBe(10);
        expect(sprite.clipNames).toEqual(['idle', 'run', 'attack']);
    });

    it('fires frame events on the sprite and its parent, and a once-clip finishes into its next', () => {
        const { scene, sprite, body } = warrior();
        const heard: string[] = [];
        sprite.onAnimationEvent = (e: string, c: string) => { heard.push(`sprite ${e} ${c}`); };
        body.onAnimationEvent = (e: string) => { heard.push(`body ${e}`); };
        body.onAnimationFinished = (c: string) => { heard.push(`done ${c}`); };
        sprite.play('attack');
        run(scene, 0.5);
        expect(heard).toEqual(['sprite swing attack', 'body swing', 'done attack']);
        expect(sprite.clip).toBe('idle');
    });

    it('switches its hitboxes on for the frames that list them', () => {
        const { scene, sprite, sword } = warrior();
        // Set from the first frame the sprite plays in its character.
        run(scene, 1 / 60);
        expect(sword.enabled).toBe(false);
        sprite.play('attack');
        run(scene, 1 / 12 + 0.01);
        expect(sword.enabled).toBe(true);
        expect(sword.offset).toEqual([1, 1]);
        expect(sword.size).toEqual([1.2, 0.8]);
        run(scene, 1 / 12);
        expect(sword.enabled).toBe(false);
    });

    it('lets its machine follow the body, and a trigger interrupt it', () => {
        const { scene, sprite, body } = warrior(true);
        expect(sprite.state).toBe('idle');
        body.velocity2D[0] = 0;
        body.controller = 'none';
        body.velocity2D[0] = 4;
        run(scene, 0.1);
        expect(sprite.state).toBe('run');
        sprite.fireTrigger('attack');
        run(scene, 0.05);
        expect(sprite.state).toBe('attack');
        body.velocity2D[0] = 0;
        run(scene, 0.5);
        expect(sprite.state).toBe('idle');
    });

    it('holds the machine off while playing a clip it has no state for', () => {
        const { scene, sprite } = warrior(true);
        sprite.animationSet = { ...sprite.animationSet!, clips: [...sprite.animationSet!.clips, { name: 'pose', fps: 1, loop: 'loop', frames: [{ tile: 5 }] }] };
        sprite.play('pose');
        expect(sprite.state).toBeNull();
        run(scene, 0.2);
        expect(sprite.clip).toBe('pose');
        sprite.resumeMachine();
        expect(sprite.state).toBe('idle');
    });

    it('round-trips its set, and leaves a frame-list sprite as it was', async () => {
        const { scene } = warrior(true);
        const json = await scene.serialize(true);
        const back = new Scene();
        back.parse(json, true);
        const s = back.findNode('Sprite') as AnimatedSpriteNode;
        expect(s.animationSet?.clips.map(c => c.name)).toEqual(['idle', 'run', 'attack']);
        expect(s.animationSet?.machine?.transitions.length).toBe(4);
        const plain = new AnimatedSpriteNode('Torch', new Sprite(), { frames: [0, 1, 2], fps: 8 });
        expect('animationSet' in (plain as any)._serializePayload()).toBe(false);
    });

    it('reads sets tolerantly', () => {
        expect(parseSpriteAnimationSet({ clips: [] })).toBeNull();
        const s = parseSpriteAnimationSet({ clips: [{ name: 'a', frames: [3, { tile: 4, duration: 0.2 }], loop: false }] })!;
        expect(s.defaultClip).toBe('a');
        expect(s.clips[0].loop).toBe('once');
        expect(s.clips[0].frames).toEqual([{ tile: 3 }, { tile: 4, duration: 0.2 }]);
    });
});
