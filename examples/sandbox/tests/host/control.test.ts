// NetSync phase 4 end to end: each peer is given a character on the host (a Player spawned from the Sandbox's
// template) and drives it with commands over a lossy link; the host simulates it, and every peer sees it move.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import type { ControllerNode, Node } from 'cleo';
import { packExampleGame } from '@host/exampleGame';
import { EXAMPLE } from '@tools/exampleKit/testKit';
import { LOSSY, intent, world, type TestPeer, type World } from '@host-tests/helpers/world';

let bin: Uint8Array;
let w: World;
const spawned = new Map<number, Node>();

/** Every node under `root`, root included. */
const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];

beforeAll(async () => {
    bin = await packExampleGame(EXAMPLE);
    w = await world(bin, {
        remote: (runtime) => ({
            // A Player for each peer, on open ground a few metres apart.
            possess: (peer) => {
                const root = runtime.scene.instantiate('Player', { position: [30 + peer.id * 4, 0.05, -30] });
                if (!root) return null;
                spawned.set(peer.id, root);
                return subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode;
            },
            // ...and it goes when they leave.
            release: (peer) => { const root = spawned.get(peer.id); if (root) runtime.scene.removeNode(root); },
        }),
    });
}, 120_000);
afterAll(() => w.dispose());

const pawnOf = (peer: TestPeer) => w.runtime.scene.getNodeById(peer.commands!.pawnId)!;
/** The pawn's body position (its Collider root), where the character actually is. */
const whereIs = (scene: { getNodeById(id: string): Node | null | undefined }, peerId: number) => {
    const root = scene.getNodeById(spawned.get(peerId)!.id)!;
    return vec3.clone(root.position as vec3);
};

describe('NetSync phase 4: each peer drives its own character', () => {
    let a: TestPeer, b: TestPeer;

    it('gives each joining peer a character of its own, and tells it which', async () => {
        a = await w.join(LOSSY);
        b = await w.join({ ...LOSSY, seed: 21 });
        await w.run(10);
        for (const p of [a, b]) {
            expect(p.commands!.pawnId).not.toBe('');
            const pawn = pawnOf(p);
            expect(pawn.nodeType).toBe('character');
            expect((w.remote!.controllerOf(p.session.peerId)!).controlSource).toBe('remote');
            // The peer has the same character in its own scene (spawned through sync).
            expect(p.scene.getNodeById(p.commands!.pawnId)).toBeTruthy();
        }
        expect(a.commands!.pawnId).not.toBe(b.commands!.pawnId);
    });

    it('moves each character the way its own player asks, and only that one', async () => {
        await w.run(30); // land
        const startA = whereIs(w.runtime.scene, a.session.peerId);
        const startB = whereIs(w.runtime.scene, b.session.peerId);
        a.drive = () => intent([0, 1]);   // forward
        b.drive = () => intent([1, 0]);   // right
        await w.run(60);
        a.drive = b.drive = null;
        await w.run(20);
        const moveA = vec3.subtract(vec3.create(), whereIs(w.runtime.scene, a.session.peerId), startA);
        const moveB = vec3.subtract(vec3.create(), whereIs(w.runtime.scene, b.session.peerId), startB);
        moveA[1] = moveB[1] = 0;
        console.log(`2 s of input at 150 ms RTT, 5 % loss: A moved ${vec3.length(moveA).toFixed(2)} m, B ${vec3.length(moveB).toFixed(2)} m`);
        expect(vec3.length(moveA)).toBeGreaterThan(3);
        expect(vec3.length(moveB)).toBeGreaterThan(3);
        // Forward and right are at right angles in one basis.
        const cos = vec3.dot(moveA, moveB) / (vec3.length(moveA) * vec3.length(moveB));
        expect(Math.abs(cos)).toBeLessThan(0.2);
        // Each player sees where its character went (and the other's): the host's state, followed.
        await w.run(30);
        for (const p of [a, b]) for (const q of [a, b]) {
            expect(vec3.distance(whereIs(p.scene, q.session.peerId), whereIs(w.runtime.scene, q.session.peerId))).toBeLessThan(0.01);
        }
    });

    it('jumps once when its player presses jump once', async () => {
        const groundY = whereIs(w.runtime.scene, a.session.peerId)[1];
        let pressed = false;
        a.drive = () => intent([0, 0], (i) => { if (!pressed) { i.requests.jump = 0.2; pressed = true; } });
        let peak = groundY;
        await w.run(45, () => { peak = Math.max(peak, whereIs(w.runtime.scene, a.session.peerId)[1]); });
        a.drive = null;
        expect(peak - groundY).toBeGreaterThan(0.3);
        // Back on the ground, and staying there: the request was used once.
        await w.run(45);
        expect(Math.abs(whereIs(w.runtime.scene, a.session.peerId)[1] - groundY)).toBeLessThan(0.05);
    });

    it('stops a character whose player stops sending, and lets it go when the player leaves', async () => {
        a.drive = () => intent([0, 1]);
        await w.run(20);
        // Commands stop (the player's link went quiet): after the hold window (6 ticks) and its own deceleration,
        // the character stands still.
        a.drive = null;
        await w.run(30);
        const p0 = whereIs(w.runtime.scene, a.session.peerId);
        await w.run(15);
        const p1 = whereIs(w.runtime.scene, a.session.peerId);
        expect(vec3.distance(p0, p1)).toBeLessThan(0.05);

        const rootId = spawned.get(b.session.peerId)!.id;
        b.session.leave();
        await w.run(20);
        expect(w.runtime.scene.getNodeById(rootId)).toBeFalsy();
        expect(a.scene.getNodeById(rootId)).toBeFalsy();
    });
});
