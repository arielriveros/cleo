// NetSync phase 8 end to end: player B runs, turns and stops on the host; player A (a predicting peer, whose scene
// runs its animators) watches B's character. Its animator must walk the states the host's does, read the host's
// speed (no foot slide), play B's actions when it draws the tick they happened on, and come back to the host's
// state if it drifts. Sandbox, 150 ms RTT, jitter and 5 % loss.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import type { Animator, ControllerNode, Node } from 'cleo';
import { animatorsOf } from '@engine/netsync';
import { packExampleGame } from '@host/exampleGame';
import { EXAMPLE } from '@tools/exampleKit/testKit';
import { LOSSY, TICK_MS, intent, world, type TestPeer, type World } from '@host-tests/helpers/world';

let w: World;
let a: TestPeer, b: TestPeer;
const players = new Map<number, Node>();
const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];
/** B's character (the Character node) on the host, and as A sees it. */
const bOnHost = () => subtree(players.get(b.session.peerId)!).find((n) => n.nodeType === 'character')!;
const bOnA = () => a.scene.getNodeById(bOnHost().id)!;
const hostAnimator = (): Animator => animatorsOf(bOnHost())[0];
const seenAnimator = (): Animator => animatorsOf(bOnA())[0];

beforeAll(async () => {
    const bin = await packExampleGame(EXAMPLE);
    w = await world(bin, {
        remote: (runtime) => ({
            possess: (peer) => {
                const root = runtime.scene.instantiate('Player', { position: [30 + peer.id * 6, 0.05, -30] })!;
                players.set(peer.id, root);
                return subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode;
            },
        }),
        anim: true,
    });
    a = await w.join(LOSSY, 'predict');
    b = await w.join({ ...LOSSY, seed: 17 });
    await w.run(60);
}, 120_000);
afterAll(() => w.dispose());

describe('NetSync phase 8: animation', () => {
    it('drives a followed character’s animator with the host’s states and speed: no foot slide', async () => {
        expect(hostAnimator()).toBeTruthy();
        expect(seenAnimator()).toBeTruthy();
        // The host's state and speed, tick by tick, to compare with what A shows at the tick it draws.
        const hostState = new Map<number, string | null>();
        const hostSpeed = new Map<number, number>();
        let sameState = 0, frames = 0, speedErr = 0, speedErrSum = 0, slide = 0, slideFrames = 0;
        const gaps: number[] = [];
        let last: vec3 | null = null;
        const plan: [number, () => ReturnType<typeof intent> | null][] = [
            [45, () => intent([0, 1])],
            [30, () => intent([0, 1], (i) => { i.sprint = true; })],
            [30, () => intent([1, 0])],
            [30, () => null],
        ];
        for (const [ticks, drive] of plan) {
            b.drive = drive;
            await w.run(ticks, (tick) => {
                // Read before this tick steps: what the previous tick left (which is what pulses for it carried).
                hostState.set(tick - 1, hostAnimator().currentStateName);
                hostSpeed.set(tick - 1, Number(hostAnimator().getParam('Speed') ?? 0));
                const exact = a.sync.renderTick();
                const at = Math.floor(exact);
                const wasState = hostState.get(at);
                // The host's speed at the moment A draws (between two ticks, as A interpolates).
                const s0 = hostSpeed.get(at), s1 = hostSpeed.get(at + 1);
                const wasSpeed = s0 === undefined ? undefined : s1 === undefined ? s0 : s0 + (s1 - s0) * (exact - at);
                if (wasState === undefined || wasSpeed === undefined) return;
                frames++;
                if (seenAnimator().currentStateName === wasState) sameState++;
                const shownSpeed = Number(seenAnimator().getParam('Speed') ?? 0);
                speedErr = Math.max(speedErr, Math.abs(shownSpeed - wasSpeed));
                speedErrSum += Math.abs(shownSpeed - wasSpeed);
                gaps.push(Math.abs(shownSpeed - wasSpeed));
                // Foot slide: the speed the animation is playing at vs how fast the character actually moves here.
                const at3 = vec3.clone(bOnA().worldPosition);
                if (last) {
                    const moved = Math.hypot(at3[0] - last[0], at3[2] - last[2]) / (TICK_MS / 1000);
                    slide += Math.abs(moved - shownSpeed);
                    slideFrames++;
                }
                last = at3;
            });
        }
        const slideMean = slide / slideFrames;
        console.log(`animation of a followed player: ${frames} frames, same state as the host ${(100 * sameState / frames).toFixed(0)} %, ` +
            `speed-parameter gap mean ${(speedErrSum / frames).toFixed(3)} m/s, largest ${speedErr.toFixed(2)} m/s, mean animation-vs-motion speed gap ${slideMean.toFixed(2)} m/s; ` +
            `${(w.anim!.stats.paramBytes / w.tick).toFixed(0)} B/tick of parameters`);
        expect(sameState / frames).toBeGreaterThan(0.9);
        // A lost pulse leaves a parameter one tick behind for a tick (one tick of braking: up to ~0.6 m/s);
        // otherwise it is the host's.
        gaps.sort((x, y) => x - y);
        expect(speedErrSum / frames).toBeLessThan(0.05);
        expect(gaps[Math.floor(gaps.length * 0.95)]).toBeLessThan(0.2);
        expect(speedErr).toBeLessThan(1);
        expect(slideMean).toBeLessThan(0.3);
    });

    it('plays an action when it draws the tick the host played it on', async () => {
        const before = a.anim!.stats.actions;
        let hostTick = -1;
        let shownAt = -1;
        await w.run(1, (tick) => { hostTick = tick; hostAnimator().playAction('LandHard'); });
        await w.run(20, () => {
            if (shownAt < 0 && a.anim!.stats.actions > before) shownAt = a.sync.renderTick();
        });
        console.log(`action: played on the host at tick ${hostTick}, on A while drawing tick ${shownAt.toFixed(2)}`);
        expect(a.anim!.stats.actions).toBe(before + 1);
        expect(Math.abs(shownAt - hostTick)).toBeLessThan(1.5);
    });

    it('brings a drifted state back to the host’s', async () => {
        await w.run(30);
        const want = hostAnimator().currentStateName!;
        const other = want === 'Fall' ? 'Idle' : 'Fall';
        seenAnimator().forceState(other);
        const forced = a.anim!.stats.forced;
        await w.run(25);
        expect(a.anim!.stats.forced).toBeGreaterThan(forced);
        expect(seenAnimator().currentStateName).toBe(hostAnimator().currentStateName);
    });
});
