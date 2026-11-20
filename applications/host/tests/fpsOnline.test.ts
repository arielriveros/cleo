// NetSync phase 9f: the Firing Line example played online — its own scripts, unchanged offline, running on a host
// and players' machines at 150 ms RTT with jitter and 5 % loss. Co-op: the players on Blue against a horde of bots.
// Team deathmatch: eight a side, players spread over the teams and bots filling the seats, a player who joins taking
// a bot's place and one who leaves giving it back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import type { ControllerNode, Node, Scene } from 'cleo';
import { packExampleGame } from '../src/exampleGame';
import { LOSSY, world, type TestPeer, type World } from './helpers/world';

const FIRING_LINE = path.resolve(__dirname, '../../editor/public/examples/firing-line');
let bin: Uint8Array;
beforeAll(async () => { bin = await packExampleGame(FIRING_LINE); }, 300_000);

const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];
const fighters = (scene: Scene) => ([...scene.nodes] as any[]).filter((n) => n.getVariable?.('fpsCombatant') && !n.markForRemoval);
const humans = (scene: Scene) => fighters(scene).filter((n) => n.getVariable?.('isPlayer'));
const managerOf = (scene: Scene) => ([...scene.nodes] as any[]).find((n) => n.name === 'FPS Game Manager');

/** A world on Firing Line where every joining player gets a copy of the project's player template, as cleo-host does. */
async function fpsWorld(mode: string) {
    const characters = new Map<number, Node>();
    const w = await world(bin, {
        scripts: true, anim: true, mode,
        remote: (runtime) => ({
            possess: (peer) => {
                const root = runtime.scene.instantiate('FPS Player', { position: [peer.id * 2, 1, 0] })!;
                characters.set(peer.id, root);
                return subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode;
            },
            release: (peer) => {
                const root = characters.get(peer.id);
                characters.delete(peer.id);
                if (root?.scene) runtime.scene.removeNode(root);
            },
        }),
    });
    /** A player's character (the FpsPlayer), on the host or in a peer's scene. */
    const playerOf = (p: TestPeer, scene: Scene = w.runtime.scene) =>
        scene.getNodeById(subtree(characters.get(p.session.peerId)!).find((n) => n.nodeType === 'character')!.id) as any;
    return { w, characters, playerOf };
}

describe('Firing Line online: co-op', () => {
    let x: Awaited<ReturnType<typeof fpsWorld>>;
    let a: TestPeer, b: TestPeer;
    beforeAll(async () => {
        x = await fpsWorld('coop');
        a = await x.w.join(LOSSY, 'predict');
        b = await x.w.join({ ...LOSSY, seed: 23 });
        await x.w.run(90);
    }, 300_000);
    afterAll(() => x.w.dispose());

    it('puts the players on Blue against the horde on Red, the same on every machine', () => {
        const host = x.w.runtime.scene;
        const gm = managerOf(host);
        expect(gm.activeType).toBe('coop');
        // The level's own player (an offline game's) is gone: each player brought their own.
        expect(humans(host).map((h) => h.net.owner).sort()).toEqual([a.session.peerId, b.session.peerId].sort());
        for (const h of humans(host)) expect(h.team).toBe('blue');
        const bots = fighters(host).filter((f) => f.getVariable('isBot'));
        expect(bots.length).toBe(gm.coopBots);
        for (const bot of bots) expect(bot.team).toBe('red');
        console.log(`co-op: ${humans(host).length} players against ${bots.length} bots; host tick ${x.w.runtime.stats().meanMs} ms mean`);
        for (const peer of [a, b]) {
            const seen = managerOf(peer.scene);
            expect(seen.activeType).toBe('coop');
            expect(Object.keys(seen.scores).sort()).toEqual(['blue', 'red']);
            expect(x.playerOf(a, peer.scene).team).toBe('blue');
        }
    });

    it('shows each player only their own HUD and viewmodel', async () => {
        await x.w.run(2);
        const hudOf = (player: any) => subtree(player).find((n: any) => n.name === 'HUD') as any;
        expect(hudOf(x.playerOf(a, a.scene)).visible).toBe(true);
        expect(hudOf(x.playerOf(b, a.scene)).visible).toBe(false);
        expect(hudOf(x.playerOf(b, b.scene)).visible).toBe(true);
    });

    it('lets a player shoot a bot: the host judges the hit, and everyone sees the damage, the kill and the score', async () => {
        const host = x.w.runtime.scene;
        const me = x.playerOf(a, a.scene);
        // The nearest living bot, as A sees it.
        const target = fighters(a.scene).filter((f) => f.getVariable('isBot') && !f.isDead)
            .sort((p, q) => dist(p.worldPosition, me.worldPosition) - dist(q.worldPosition, me.worldPosition))[0];
        const onHost = host.getNodeById(target.id) as any;
        const hp0 = onHost.hp;
        let shots = 0;
        // A's machine fires at it (what FpsPlayer._shoot sends), a shot as often as the rifle allows, until it falls.
        // Bots move and take cover: some shots miss, as they would for a player.
        for (let i = 0; i < 120 && !onHost.isDead; i++) {
            const from = me.worldPosition, to = target.chest;
            const origin = [from[0], from[1] + 1.55, from[2]];
            const dir = norm([to[0] - origin[0], to[1] - origin[1], to[2] - origin[2]]);
            me.shot(origin, dir, 0, 'ak47', me.net.viewTick);
            shots++;
            await x.w.run(4);
        }
        await x.w.run(15);
        console.log(`co-op shot: ${shots} shots, the bot went from ${hp0} hp to dead: ${onHost.isDead}; A's kills ${x.playerOf(a).kills}`);
        expect(onHost.isDead).toBe(true);
        // Everyone sees it: the bot dead, A's kill, Blue's point; A's machine flashed its hit marker.
        expect((a.scene.getNodeById(target.id) as any)?.isDead ?? true).toBe(true);
        expect((b.scene.getNodeById(target.id) as any)?.isDead ?? true).toBe(true);
        expect(x.playerOf(a).kills).toBe(1);
        expect(x.playerOf(a, b.scene).kills).toBe(1);
        expect(managerOf(b.scene).scores.blue).toBe(1);
        expect(me.hitMarkerAt).toBeGreaterThan(0);
    }, 60_000);

    it('refuses a shot from too far from the shooter, and one for a weapon it does not carry', async () => {
        const me = x.playerOf(a, a.scene), onHost = x.playerOf(a);
        const before = onHost.weapon;
        me.shot([0, 500, 0], [0, -1, 0], 0, 'ak47');
        me.shot(me.worldPosition, [0, 0, 1], 0, 'railgun');
        await x.w.run(10);
        expect(onHost.weapon).toBe(before);
    });
});

describe('Firing Line online: team deathmatch', () => {
    let x: Awaited<ReturnType<typeof fpsWorld>>;
    beforeAll(async () => { x = await fpsWorld('deathmatch'); }, 300_000);
    afterAll(() => x.w.dispose());

    it('plays eight against eight: players spread over the teams, bots in the seats left', async () => {
        const host = x.w.runtime.scene;
        // The bots' bullets do no harm here: a fighter between death and respawn would make the head-count wobble.
        const calm = () => { for (const f of fighters(host)) if (f.getVariable('isBot')) f.damageScale = 0; };
        const run = (ticks: number) => x.w.run(ticks, calm);
        const a = await x.w.join(LOSSY);
        const b = await x.w.join({ ...LOSSY, seed: 41 });
        await run(90);
        const count = (team: string, pick = (_: any) => true) => fighters(host).filter((f) => f.team === team && pick(f)).length;
        const isHuman = (f: any) => !!f.getVariable('isPlayer');
        console.log(`deathmatch: blue ${count('blue')} (${count('blue', isHuman)} players), red ${count('red')} (${count('red', isHuman)} players)`);
        expect(count('blue')).toBe(8);
        expect(count('red')).toBe(8);
        expect(count('blue', isHuman)).toBe(1);
        expect(count('red', isHuman)).toBe(1);
        expect(x.playerOf(a).team).not.toBe(x.playerOf(b).team);

        // A third player takes a bot's place: still sixteen.
        const c = await x.w.join({ ...LOSSY, seed: 43 });
        await run(30);
        expect(fighters(host).length).toBe(16);
        expect(humans(host).length).toBe(3);
        // One leaves: a bot comes back for the seat.
        c.session.leave();
        await run(60);
        expect(humans(host).length).toBe(2);
        expect(fighters(host).length).toBe(16);
        expect(count('blue')).toBe(8);
        expect(count('red')).toBe(8);
    }, 120_000);
});

function dist(p: ArrayLike<number>, q: ArrayLike<number>): number { return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
function norm(v: number[]): number[] { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
