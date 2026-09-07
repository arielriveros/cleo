import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene } from '../src/core/scene/scene';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { CleoEngine } from '../src/core/engine';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { DirectionalLight, REFERENCE_ILLUMINANCE } from '../src/graphics/lighting';
import { Game } from '../src/core/game';
import { Node } from '../src/core/scene/nodes/node';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript } from '../src/core/scripting/scriptRuntime';
import { Logger } from '../src/core/logger';
import { readFileSync } from 'fs';
import { join } from 'path';
import '../src/cleo';   // registers the 'cleo' module the example scripts import from

import NightShiftDirectorNode from '../examples/scripts/NightShiftDirector';
import NightShiftPlayerNode from '../examples/scripts/NightShiftPlayer';
import NightShiftZombieNode from '../examples/scripts/NightShiftZombie';
import NightShiftZombieBrainNode from '../examples/scripts/NightShiftZombieBrain';
import NightShiftSpawnerNode from '../examples/scripts/NightShiftSpawner';
import NightShiftPickupNode from '../examples/scripts/NightShiftPickup';
import NightShiftPowerupNode from '../examples/scripts/NightShiftPowerup';

// The Night Shift example game. These scripts are the one place in the repo where the engine's pieces
// are wired into an actual game, and three of the joins are things nothing else would catch:
//
//   - the faction filter, which exists ONLY because the engine has no team concept and auto-acquire
//     would otherwise have zombies hunting each other;
//   - the powerup restore, which must not be scheduled on the node that removes itself;
//   - the difficulty curve, which is the whole progression and is otherwise only observable by playing.
//
// The clock and the burn are here because they are pure arithmetic over time, and arithmetic that is
// only ever checked by watching a sunrise is arithmetic nobody checks.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

/** Run `seconds` of game time through a started scene, a frame at a time. */
function run(scene: Scene, seconds: number, dt = 1 / 60): void {
    const frames = Math.ceil(seconds / dt);
    for (let i = 0; i < frames; i++) scene.update(dt, i * dt, false);
}

describe('the level clock', () => {
    function director(levelSeconds = 180) {
        const scene = new Scene();
        const node = new NightShiftDirectorNode('GameManager');
        node.levelSeconds = levelSeconds;
        scene.addNode(node);
        scene.start();
        return { scene, node };
    }

    it('starts at dusk and ends at dawn', () => {
        const { scene, node } = director(10);
        expect(node.clockText).toBe('22:00');
        run(scene, 10);
        expect(node.progress).toBe(1);
        expect(node.clockText).toBe('06:00');
    });

    it('wraps past midnight rather than reading 26:00', () => {
        const { scene, node } = director(10);
        run(scene, 5.05);
        // 22:00 + ~4h. The hour is the assertion; the minute is a frame-quantised value and pinning it
        // would only pin the test runner's floating point.
        expect(node.clockText.slice(0, 2)).toBe('02');
    });

    it('lifts the sun from below the horizon to above it', () => {
        const { scene, node } = director(10);
        expect(node.sunElevation).toBeLessThan(0);
        run(scene, 10);
        expect(node.sunElevation).toBeGreaterThan(0);
    });

    it('flips isDay exactly when the sun crosses the horizon', () => {
        const { scene, node } = director(10);
        expect(node.isDay).toBe(false);

        // The crossing is where elevation hits 0, i.e. -night / (day - night) of the way through.
        const crossing = -node.nightElevation / (node.dayElevation - node.nightElevation);
        run(scene, 10 * crossing - 0.5);
        expect(node.sunElevation).toBeLessThan(0);
        expect(node.isDay).toBe(false);

        run(scene, 1);
        expect(node.sunElevation).toBeGreaterThan(0);
        expect(node.isDay).toBe(true);
    });

    it('stops the clock once the level is over', () => {
        const { scene, node } = director(10);
        run(scene, 10);
        expect(node.finished).toBe(true);

        const at = node.progress;
        run(scene, 5);
        expect(node.progress).toBe(at);
    });

    it('ends the level exactly once', () => {
        const { scene, node } = director(2);
        let ends = 0;
        const original = node.endLevel.bind(node);
        node.endLevel = (won: boolean) => { ends++; original(won); };
        run(scene, 6);
        expect(ends).toBe(1);
    });
});

describe('the sun, in the units the renderer actually reads', () => {
    // Lights are PHOTOMETRIC. `DEFAULT_DIRECTIONAL_LUX` is 100000 and the reference illuminance is
    // 78643, so an intensity written as though it were a 0..1 multiplier is not dim, it is black — and
    // a black screen names nothing. Same for `scene.ambientLight`, which is lux and not a colour.
    // Both of those shipped wrong once; these are here so they cannot again.

    function lit(levelSeconds = 10) {
        const scene = new Scene();
        const sun = new LightNode('Sun', new DirectionalLight({}));
        const node = new NightShiftDirectorNode('GameManager');
        node.levelSeconds = levelSeconds;
        scene.addNode(sun);
        scene.addNode(node);
        scene.start();
        return { scene, node, sun };
    }

    it('lights the night far above a 0..1 multiplier', () => {
        const { node, sun } = lit();
        const light = sun.light as DirectionalLight;
        expect(light.intensity).toBe(node.nightLux);
        // The failure being guarded: anything on a 0..1 scale renders as black.
        expect(light.intensity).toBeGreaterThan(1000);
    });

    it('reaches daylight by dawn', () => {
        const { scene, node, sun } = lit();
        run(scene, 10);
        const light = sun.light as DirectionalLight;
        expect(light.intensity).toBeCloseTo(node.dayLux, 0);
        expect(light.intensity / REFERENCE_ILLUMINANCE).toBeGreaterThan(0.5);
    });

    it('keeps the night dimmer than the day, but not by more than a few stops', () => {
        const { scene, node, sun } = lit();
        const light = sun.light as DirectionalLight;
        const night = light.intensity;
        run(scene, 10);
        const day = light.intensity;
        expect(night).toBeLessThan(day);
        // Below about 1/64 the night is unplayable however far exposure opens.
        expect(night / day).toBeGreaterThan(1 / 64);
    });

    it('writes ambient in lux, not as a colour', () => {
        const { scene } = lit();
        const ambient = scene.ambientLight;
        expect(Math.max(ambient[0], ambient[1], ambient[2])).toBeGreaterThan(100);
    });

    it('lights the night mostly from ambient, because the sun is under the horizon', () => {
        // The one that matters for "I cannot see anything": for most of the night the sun sits well
        // below the horizon, where `N dot L < 0` on every upward-facing surface and the directional
        // light contributes nothing to the ground. Ambient is the only thing lighting the terrain, so
        // it has to be a real fraction of the reference illuminance rather than a token value.
        const { scene, node } = lit();
        expect(node.sunElevation).toBeLessThan(0);
        const ambient = Math.max(...scene.ambientLight);
        // A real fraction of the reference, not a token value — the guard is against the unit error
        // (a 0..1 colour written into a lux field), not against the night being dark.
        expect(ambient / REFERENCE_ILLUMINANCE).toBeGreaterThan(0.02);
    });

    it('gets brighter from dusk to dawn', () => {
        // The invariant that actually matters, and it is about the WHOLE budget rather than any one
        // term: ambient carries the night, the sun carries the day, and exposure only trims. An earlier
        // version of this test asserted night ambient should EXCEED day ambient, which was a fact about
        // an over-bright night rather than about the level being a night at all.
        const exposures: number[] = [];
        const original = Game.updateRenderSettings;
        Game.updateRenderSettings = (settings: any) => {
            if (typeof settings.exposure === 'number') exposures.push(settings.exposure);
        };
        try {
            const { scene } = lit(4);
            run(scene, 1 / 60);
            const night = Math.max(...scene.ambientLight) * exposures[0];
            run(scene, 5);
            const day = Math.max(...scene.ambientLight) * exposures[exposures.length - 1];
            expect(night).toBeLessThan(day * 0.6);
        } finally {
            Game.updateRenderSettings = original;
        }
    });

    it('does not lean on exposure to carry the night', () => {
        // Exposure is a correction, not the lighting. Pushed far enough to light a scene on its own it
        // flattens the contrast between the lit and unlit parts and washes the frame out — which is
        // what "the exposure is very aggressive" looks like from the other side of the screen.
        const exposures: number[] = [];
        const original = Game.updateRenderSettings;
        Game.updateRenderSettings = (settings: any) => {
            if (typeof settings.exposure === 'number') exposures.push(settings.exposure);
        };
        try {
            const { scene } = lit(4);
            run(scene, 5);
        } finally {
            Game.updateRenderSettings = original;
        }
        const night = exposures[0];
        const day = exposures[exposures.length - 1];
        expect(night).toBeGreaterThan(day);          // still opens up at night
        expect(night / day).toBeLessThan(1.6);       // but only as a trim, not as the light source
    });

    it('opens the exposure at night and stops it down by dawn', () => {
        // Backwards is the intuitive-looking mistake: it dims the darkest part of the level.
        const seen: number[] = [];
        const original = Game.updateRenderSettings;
        Game.updateRenderSettings = (settings: any) => {
            if (typeof settings.exposure === 'number') seen.push(settings.exposure);
        };
        try {
            const { scene } = lit();
            run(scene, 10);
        } finally {
            Game.updateRenderSettings = original;
        }
        expect(seen.length).toBeGreaterThan(2);
        expect(seen[0]).toBeGreaterThan(seen[seen.length - 1]);
    });

    it('hands the renderer back its settings when play stops', () => {
        // Render settings are a GLOBAL the editor viewport shares with Play. Ramping them and not
        // restoring leaves the editor stuck on the level's look — "the scene went dark after I played".
        const applied: any[] = [];
        const original = Game.updateRenderSettings;
        const originalGet = Game.getRenderSettings;
        Game.getRenderSettings = () => ({ exposure: 2, saturation: 1, vignetteStrength: 0 }) as any;
        Game.updateRenderSettings = (settings: any) => { applied.push(settings); };
        try {
            const { scene, node } = lit();
            run(scene, 3);
            applied.length = 0;
            node.despawn();
        } finally {
            Game.updateRenderSettings = original;
            Game.getRenderSettings = originalGet;
        }
        expect(applied).toEqual([{ exposure: 2, saturation: 1, vignetteStrength: 0 }]);
    });

    it('survives a scene with no Sun at all', () => {
        // isDay is derived from the clock, so the level still ends even with nothing to light it.
        const scene = new Scene();
        const node = new NightShiftDirectorNode('GameManager');
        node.levelSeconds = 5;
        scene.addNode(node);
        scene.start();
        run(scene, 6);
        expect(node.isDay).toBe(true);
        expect(node.finished).toBe(true);
    });
});

describe('the director as the EDITOR runs it', () => {
    // Every other test here constructs the class directly, where getters work like any class instance.
    // The editor does not: it compiles the source and copies the members onto a live node, and that path
    // dropped accessors entirely — `this.progress` read `undefined`, `lerp(a, b, undefined)` returned
    // NaN, and a NaN exposure went to the renderer every frame. The screen was black and nothing said
    // why. Constructing the class could never have caught it, so this attaches the real source instead.

    function attached() {
        const scene = new Scene();
        const sun = new LightNode('Sun', new DirectionalLight({}));
        const node = new Node('GameManager');
        scene.addNode(sun);
        scene.addNode(node);
        const source = readFileSync(join(__dirname, '..', 'examples', 'scripts', 'NightShiftDirector.ts'), 'utf8');
        attachScriptFactory(node, compileScript(source));
        scene.start();
        return { scene, node: node as any };
    }

    it('exposes its computed values on the node', () => {
        const { node } = attached();
        expect(typeof node.progress, 'progress').toBe('number');
        expect(typeof node.sunElevation, 'sunElevation').toBe('number');
        expect(typeof node.clockText, 'clockText').toBe('string');
        expect(typeof node.isDay, 'isDay').toBe('boolean');
    });

    it('starts at dusk and reaches dawn', () => {
        const { scene, node } = attached();
        expect(node.clockText).toBe('22:00');
        node.levelSeconds = 4;
        run(scene, 5);
        expect(node.progress).toBe(1);
        expect(node.isDay).toBe(true);
    });

    it('never sends the renderer a NaN', () => {
        // The actual failure. A NaN exposure blacks the whole frame and reports nothing.
        const bad: string[] = [];
        const original = Game.updateRenderSettings;
        Game.updateRenderSettings = (settings: any) => {
            for (const [key, value] of Object.entries(settings))
                if (typeof value !== 'number' || !Number.isFinite(value)) bad.push(`${key}=${value}`);
        };
        try {
            const { scene, node } = attached();
            node.levelSeconds = 4;
            run(scene, 5);
        } finally {
            Game.updateRenderSettings = original;
        }
        expect(bad).toEqual([]);
    });

    it('leaves the sun and the ambient as finite numbers', () => {
        const { scene, node } = attached();
        run(scene, 1);
        const light = (scene.findNode('Sun') as any).light;
        expect(Number.isFinite(light.intensity), 'sun intensity').toBe(true);
        expect(light.intensity).toBeGreaterThan(1000);
        for (const channel of scene.ambientLight)
            expect(Number.isFinite(channel), 'ambient channel').toBe(true);
        expect(Math.max(...scene.ambientLight)).toBeGreaterThan(100);
    });

    it('gets through onStart without throwing', () => {
        // onStart used to die on `this.sunElevation.toFixed(1)`, which stopped the sun timer ever being
        // registered — so the level was frozen at whatever the first broken frame produced.
        const errors: string[] = [];
        const originalError = Logger.error;
        Logger.error = (m: unknown) => { errors.push(String(m)); };
        try { attached(); } finally { Logger.error = originalError; }
        expect(errors).toEqual([]);
    });
});

describe('the difficulty curve', () => {
    function spawner(level: number, progress: number) {
        const scene = new Scene();
        const gm = new NightShiftDirectorNode('GameManager');
        gm.levelSeconds = 100;
        gm.level = level;
        const node = new NightShiftSpawnerNode('ZombieSpawner');
        scene.addNode(gm);
        scene.addNode(node);
        scene.start();
        run(scene, 100 * progress);
        return node;
    }

    it('spawns faster on a later level', () => {
        expect(spawner(5, 0).intervalSeconds()).toBeLessThan(spawner(1, 0).intervalSeconds());
    });

    it('spawns faster as the night wears on', () => {
        expect(spawner(1, 0.9).intervalSeconds()).toBeLessThan(spawner(1, 0).intervalSeconds());
    });

    it('never drops below its floor, however deep the level', () => {
        const node = spawner(500, 0.99);
        expect(node.intervalSeconds()).toBeGreaterThanOrEqual(node.minInterval);
    });

    it('falls monotonically across the night', () => {
        const samples = [0, 0.25, 0.5, 0.75, 1].map(p => spawner(3, p).intervalSeconds());
        for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    });
});

describe('a zombie brain, with no faction system to lean on', () => {
    interface World {
        scene: Scene;
        brain: NightShiftZombieBrainNode;
        player: NightShiftPlayerNode;
        self: CharacterNode;
        other: CharacterNode;
    }

    function world(): World {
        const scene = new Scene();
        const self = new CharacterNode('zombie');
        const other = new CharacterNode('other zombie');
        const player = new NightShiftPlayerNode('Playable');
        const brain = new NightShiftZombieBrainNode('Brain');
        scene.addNode(self);
        scene.addNode(other);
        scene.addNode(player);
        scene.addNode(brain);
        brain.possess(self);
        brain.controlSource = 'ai';
        // Off, exactly as the template authors it — the whole point is that ours runs instead.
        brain.autoAcquire = false;
        brain.perception = { fieldOfView: 120, range: 20, memorySpan: 3, reactionTime: 0 };
        scene.start();
        return { scene, brain, player, self, other };
    }

    it('hunts the player', () => {
        const w = world();
        w.player.setPosition([0, 0, 6]);
        run(w.scene, 1 / 60);
        expect(w.brain.getBlackboard('target')).toBe(w.player.id);
    });

    it('ignores another zombie standing closer than the player', () => {
        // The bug this exists to prevent: auto-acquire takes the nearest NOTICED character, and a
        // zombie is a character. Left alone, the horde hunts itself while the player walks past.
        const w = world();
        w.other.setPosition([0, 0, 2]);
        w.player.setPosition([0, 0, 10]);
        run(w.scene, 1 / 60);
        expect(w.brain.getBlackboard('target')).toBe(w.player.id);
    });

    it('takes no target at all when only zombies are in view', () => {
        const w = world();
        w.other.setPosition([0, 0, 3]);
        w.player.setPosition([0, 0, 200]);
        run(w.scene, 1 / 60);
        expect(w.brain.getBlackboard('target')).toBeUndefined();
    });

    it('takes the nearer of two players', () => {
        const w = world();
        const second = new NightShiftPlayerNode('Playable 2');
        w.scene.addNode(second);
        second.onStart();
        w.player.setPosition([0, 0, 12]);
        second.setPosition([0, 0, 4]);
        run(w.scene, 1 / 60);
        expect(w.brain.getBlackboard('target')).toBe(second.id);
    });

    it('remembers a target it can no longer see', () => {
        // What makes `investigate` mean anything: dropping the target the frame line of sight breaks is
        // how an agent forgets you the instant you round a corner.
        const w = world();
        w.player.setPosition([0, 0, 6]);
        run(w.scene, 1 / 60);
        expect(w.brain.getBlackboard('target')).toBe(w.player.id);

        w.player.setPosition([0, 0, -60]);   // behind it and far out of range
        run(w.scene, 1);
        expect(w.brain.getBlackboard('target')).toBe(w.player.id);
    });

    it('forgets it once the memory span lapses', () => {
        const w = world();
        w.player.setPosition([0, 0, 6]);
        run(w.scene, 1 / 60);
        w.player.setPosition([0, 0, -60]);
        run(w.scene, w.brain.perception.memorySpan + 0.5);
        expect(w.brain.getBlackboard('target')).toBeUndefined();
    });
});

describe('the player', () => {
    function player() {
        const scene = new Scene();
        const gm = new NightShiftDirectorNode('GameManager');
        const node = new NightShiftPlayerNode('Playable');
        scene.addNode(gm);
        scene.addNode(node);
        scene.start();
        return { scene, node, gm };
    }

    it('marks itself so the zombie brains can tell it apart', () => {
        const { node } = player();
        expect(node.getVariable('isPlayer')).toBe(true);
    });

    it('takes damage, and stops at zero', () => {
        const { node } = player();
        expect(node.damage(30)).toBe(true);
        expect(node.health).toBe(70);
        node.damage(500);
        expect(node.health).toBe(0);
    });

    it('takes no damage while invincible', () => {
        const { node } = player();
        node.grantInvincibility();
        expect(node.damage(30)).toBe(false);
        expect(node.health).toBe(node.maxHealth);
    });

    it('ends the level the first time it dies, and not again', () => {
        const { node, gm } = player();
        let ends = 0;
        gm.endLevel = () => { ends++; };
        node.damage(1000);
        node.damage(1000);
        expect(ends).toBe(1);
    });

    it('restores the authored speed when the boost lapses', () => {
        const { scene, node } = player();
        const walk = node.walkSpeed;
        const run_ = node.runSpeed;

        node.grantSpeed();
        expect(node.walkSpeed).toBeGreaterThan(walk);

        run(scene, node.speedSeconds + 0.5);
        expect(node.speedLeft).toBe(0);
        expect(node.walkSpeed).toBeCloseTo(walk, 6);
        expect(node.runSpeed).toBeCloseTo(run_, 6);
    });

    it('does not compound a boost taken while one is already running', () => {
        // Multiplying again on the second pickup, then dividing once, is how a player ends a level
        // permanently faster than the design intended.
        const { scene, node } = player();
        const walk = node.walkSpeed;
        node.grantSpeed();
        run(scene, 1);
        node.grantSpeed();
        const boosted = node.walkSpeed;
        expect(boosted).toBeCloseTo(walk * node.speedMultiplier, 6);

        run(scene, node.speedSeconds + 0.5);
        expect(node.walkSpeed).toBeCloseTo(walk, 6);
    });
});

describe('a pickup', () => {
    function pickup() {
        const scene = new Scene();
        const gm = new NightShiftDirectorNode('GameManager');
        const player = new NightShiftPlayerNode('Playable');
        const node = new NightShiftPickupNode('Coin');
        scene.addNode(gm);
        scene.addNode(player);
        scene.addNode(node);
        scene.start();
        return { scene, gm, player, node };
    }

    it('scores once', () => {
        const { gm, player, node } = pickup();
        node.onTrigger(player);
        expect(gm.score).toBe(node.points);
        expect(gm.itemsFound).toBe(1);
    });

    it('scores once even when the trigger re-fires', () => {
        // Enter is guarded on the previous frame's contact matrix, but grazing an edge genuinely loses
        // and regains contact — and there is no exit event to pair the latch with.
        const { gm, player, node } = pickup();
        node.onTrigger(player);
        node.onTrigger(player);
        node.onTrigger(player);
        expect(gm.score).toBe(node.points);
        expect(gm.itemsFound).toBe(1);
    });

    it('ignores anything that is not the player', () => {
        const { gm, node } = pickup();
        node.onTrigger(new CharacterNode('zombie'));
        expect(gm.score).toBe(0);
    });
});

describe('a powerup', () => {
    function world(kind: string) {
        const scene = new Scene();
        const gm = new NightShiftDirectorNode('GameManager');
        const player = new NightShiftPlayerNode('Playable');
        const node = new NightShiftPowerupNode('Boost');
        node.kind = kind;
        scene.addNode(gm);
        scene.addNode(player);
        scene.addNode(node);
        scene.start();
        return { scene, player, node };
    }

    it('grants speed, and the countdown outlives the pickup that granted it', () => {
        // The trap: `remove()` cancels the node's own timers BEFORE onDespawn, so a restore scheduled
        // on the pickup would never fire and the boost would last the rest of the level.
        const { scene, player, node } = world('speed');
        const walk = player.walkSpeed;
        node.onTrigger(player);
        expect(node.markForRemoval).toBe(true);
        expect(player.walkSpeed).toBeGreaterThan(walk);

        run(scene, player.speedSeconds + 0.5);
        expect(player.walkSpeed).toBeCloseTo(walk, 6);
    });

    it('grants invincibility and drops it again', () => {
        const { scene, player, node } = world('invincible');
        node.onTrigger(player);
        expect(player.invincible).toBe(true);
        run(scene, player.invincibleSeconds + 0.5);
        expect(player.invincible).toBe(false);
    });

    it('ignites zombies in range and spares the ones outside it', () => {
        const { scene, player, node } = world('aoe');
        const near = new NightShiftZombieNode('near');
        const far = new NightShiftZombieNode('far');
        scene.addNode(near);
        scene.addNode(far);
        near.onStart();
        far.onStart();
        near.setPosition([0, 0, 5]);
        far.setPosition([0, 0, 500]);
        // `worldPosition` is a lazily-refilled cache, so the blast has to run against transforms that
        // have actually been solved. In the game that is guaranteed — onTrigger fires inside the node
        // loop, after the frame's updateTransforms.
        run(scene, 1 / 60);

        node.onTrigger(player);
        expect(near.burning).toBe(true);
        expect(far.burning).toBe(false);
    });

    it('never ignites the player', () => {
        const { player, node } = world('aoe');
        node.onTrigger(player);
        expect(player.getVariable('isPlayer')).toBe(true);
        expect((player as any).burning).toBeUndefined();
    });
});

describe('a burning zombie', () => {
    function zombie() {
        const scene = new Scene();
        const node = new NightShiftZombieNode('Zombie');
        node.burnSeconds = 1;
        node.corpseSeconds = 1;
        scene.addNode(node);
        scene.start();
        return { scene, node };
    }

    it('is removed once it has burned and lain there', () => {
        const { scene, node } = zombie();
        node.ignite();
        expect(node.markForRemoval).toBe(false);

        run(scene, node.burnSeconds + 0.1);
        expect(node.markForRemoval).toBe(false);   // dead, but still a corpse

        run(scene, node.corpseSeconds + 0.1);
        expect(node.markForRemoval).toBe(true);
    });

    it('ignores a second ignition', () => {
        // Dawn and an AoE blast can name the same zombie on the same frame.
        const { scene, node } = zombie();
        node.ignite();
        run(scene, 0.5);
        node.ignite();
        run(scene, 0.6);
        // Still on the first burn's schedule: it died on time rather than restarting the countdown.
        run(scene, node.corpseSeconds + 0.1);
        expect(node.markForRemoval).toBe(true);
    });

    it('does not burn until something ignites it', () => {
        const { scene, node } = zombie();
        run(scene, 10);
        expect(node.burning).toBe(false);
        expect(node.markForRemoval).toBe(false);
    });
});
