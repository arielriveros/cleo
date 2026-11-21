// A peer predicts a character the level placed (the Sandbox's own Player), not one the host spawned for it. The
// peer parsed that character as a follower, like everything the host simulates; once the host says it is this
// peer's, the peer takes it back — its body dynamic again — and drives it ahead of the host as it would a spawned
// one. 150 ms RTT with jitter and 5 % loss.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import type { ControllerNode, Node } from 'cleo';
import { packExampleGame } from '@host/exampleGame';
import { EXAMPLE } from '@tools/exampleKit/testKit';
import { LOSSY, intent, world, type TestPeer, type World } from '@host-tests/helpers/world';

let w: World;
let me: TestPeer;
let placed: Node;
const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];

beforeAll(async () => {
    const bin = await packExampleGame(EXAMPLE);
    w = await world(bin, {
        remote: (runtime) => ({
            possess: () => {
                // The level's own Player: its top-level node.
                let n: Node | null = [...runtime.scene.nodes].find((x: any) => x.nodeType === 'character') as Node;
                while (n?.parent && n.parent !== runtime.scene.root) n = n.parent;
                placed = n!;
                return subtree(placed).find((x) => x.nodeType === 'controller') as ControllerNode;
            },
        }),
    });
    me = await w.join(LOSSY, 'predict');
    await w.run(45);
}, 120_000);
afterAll(() => w.dispose());

describe('NetSync: predicting a character the level placed', () => {
    it('takes the character back from following: its body dynamic, driven here', () => {
        const pawn = me.predictor!.pawn!;
        expect(pawn).toBeTruthy();
        expect(subtree(placed).some((n) => n.id === pawn.id)).toBe(true);
        const body = (pawn.parent as any).body;
        expect(body.isDynamic).toBe(true);
        expect((pawn.parent as any).simulatePhysics).toBe(true);
    });

    it('answers its player at once and ends where the host has it', async () => {
        const hostAt = () => vec3.clone(placed.position as vec3);
        const here = () => vec3.clone(me.scene.getNodeById(placed.id)!.position as vec3);
        const start = here(), hostStart = hostAt();
        me.drive = () => intent([0, 1]);
        await w.run(3);
        // Moving here before the host has heard of it (a round trip is ~5 ticks).
        expect(vec3.distance(here(), start)).toBeGreaterThan(0.02);
        expect(vec3.distance(hostAt(), hostStart)).toBeLessThan(0.005);
        await w.run(45);
        me.drive = null;
        await w.run(90); // the host comes to rest a round trip after this peer does
        const stats = me.predictor!.stats;
        console.log(`placed character: moved ${vec3.distance(start, hostAt()).toFixed(2)} m on the host; ${stats.checked} checked, ` +
            `${stats.corrections} corrected; here vs host ${(vec3.distance(here(), hostAt()) * 100).toFixed(1)} cm`);
        expect(vec3.distance(start, hostAt())).toBeGreaterThan(2);
        expect(vec3.distance(here(), hostAt())).toBeLessThan(0.03);
    });
});
