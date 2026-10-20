import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import '../src/cleo';   // registers the 'cleo' module the example scripts import from

import SoulsBreakableNode from '../examples/scripts/SoulsBreakable';
import SoulsDebrisNode from '../examples/scripts/SoulsDebris';
import { isHurtbox } from '../examples/scripts/SoulsHitbox';

// The Valley's barrels: a swing or a roll breaks one, it swaps itself for its debris template, and the
// debris gives every piece a body and dissolves it away. Driven against a real Scene, no renderer.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

const FRAME = 1 / 60;
const run = (scene: Scene, seconds: number) => { for (let t = 0; t < seconds; t += FRAME) scene.update(FRAME, 0, false); };

function barrelScene() {
    const scene = new Scene();
    const barrel = new SoulsBreakableNode('Breakable Barrel');
    scene.addNode(barrel);
    const debris = { burst: vi.fn() };
    const instantiate = vi.spyOn(scene, 'instantiate').mockReturnValue(debris as any);
    scene.start();
    return { scene, barrel, debris, instantiate };
}

describe('a breakable barrel', () => {
    it('is a hurtbox for the player swings, and not once broken', () => {
        const { barrel } = barrelScene();
        const player = new Node('Player');
        expect(isHurtbox(barrel, player, 'enemy')).toBe(true);
        barrel.shatter();
        expect(isHurtbox(barrel, player, 'enemy')).toBe(false);
    });

    it('breaks on a hit, pushed away from whoever struck it', () => {
        const { scene, barrel, debris, instantiate } = barrelScene();
        const attacker = new Node('Attacker');
        scene.addNode(attacker);
        attacker.setPosition([-2, 0, 0]);
        scene.update(FRAME, 0, false);
        expect(barrel.receiveHit(50, 10, attacker)).toBe(true);
        expect(instantiate).toHaveBeenCalledWith('Barrel Debris', expect.anything());
        const push = debris.burst.mock.calls[0][0] as number[];
        expect(push[0]).toBeGreaterThan(0);
        expect(barrel.markForRemoval).toBe(true);
        // A second blow lands on nothing.
        expect(barrel.receiveHit(50, 10, attacker)).toBe(false);
    });

    it('breaks when the player rolls into it, and not when the player only walks in', () => {
        const { barrel, scene } = barrelScene();
        const walker: any = new Node('Player');
        walker.actionState = 'free';
        Object.defineProperty(walker, 'velocity', { get: () => [3, 0, 0] });
        barrel.onTriggerEnter(walker);
        scene.update(FRAME, 0, false);
        expect(barrel.isBroken).toBe(false);
        walker.actionState = 'roll';
        scene.update(FRAME, 0, false);
        expect(barrel.isBroken).toBe(true);
    });
});

describe('barrel debris', () => {
    function piece(name: string, at: [number, number, number]) {
        const n: any = new Node(name);
        n.model = { geometry: { boundingBox: { min: [-0.1, -0.4, -0.02], max: [0.1, 0.4, 0.02] } } };
        n.setPosition(at);
        return n as Node;
    }

    it('frees every piece onto the scene root with its own body, then dissolves them away', () => {
        const scene = new Scene();
        const debris = new SoulsDebrisNode('Barrel Debris');
        scene.addNode(debris);
        const pieces = [piece('Stave 1', [0.3, 0.45, 0]), piece('Stave 2', [-0.3, 0.45, 0])];
        for (const p of pieces) debris.addChild(p);
        scene.start();
        debris.burst([2, 0, 0]);
        for (const p of pieces) {
            expect(p.parent).toBe(scene.root);
            expect(p.body).toBeTruthy();
            expect(p.body!.mass).toBeGreaterThan(0);
        }
        run(scene, debris.lifeSeconds + debris.lifeJitter + scene.despawnFadeSeconds + 0.6);
        for (const p of pieces) expect(p.markForRemoval, p.name).toBe(true);
    });
});
