// NetSync phase 7 end to end: game scripts written with `this.net`, `@synced` and `@netcall` — a door anyone can
// open, a scoreboard, a pickup and a player's gun — added to the Sandbox and its Player template, and run on a host
// and two peers (A predicts its character, B follows) at 150 ms RTT with jitter and 5 % loss.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { GameEvents, Scene, type ControllerNode, type Node } from 'cleo';
import { packExampleGame } from '@host/exampleGame';
import { EXAMPLE } from '@tools/exampleKit/testKit';
import { LOSSY, world, type TestPeer, type World } from '@host-tests/helpers/world';

const DOOR = `import { Node } from 'cleo'
import { netcall, synced, observable, eventListener } from 'cleo/decorators'
export default class NetDoor extends Node {
  @synced({ onChange: 'swing' }) @observable open = false
  swings = 0
  openings = 0
  @eventListener('openChanged') opened(now: boolean) { if (now) this.openings++ }
  @netcall({ to: 'host', anyone: true }) toggle() { this.open = !this.open }
  swing(was: boolean) { this.swings++ }
}`;

const SCOREBOARD = `import { Node } from 'cleo'
import { synced } from 'cleo/decorators'
export default class NetScoreboard extends Node {
  @synced scores: Record<string, number> = {}
  @synced leader: Node | null = null
  add(peer: number) {
    this.scores = { ...this.scores, [peer]: (this.scores[peer] ?? 0) + 1 }
  }
}`;

const PICKUP = `import { Node } from 'cleo'
import { netcall } from 'cleo/decorators'
export default class NetPickup extends Node {
  @netcall({ to: 'host', anyone: true }) take() {
    if (!this.net.isHost || !this.scene) return
    ;(this.scene.findNode('Scoreboard') as any).add(this.net.caller)
    this.scene.removeNode(this)
  }
}`;

const GUN = `import { Node } from 'cleo'
import { netcall } from 'cleo/decorators'
export default class NetGun extends Node {
  shots = 0
  flashes = 0
  lastHint = ''
  @netcall({ to: 'host' }) fire(target: Node | null) {
    this.shots++
    if (target) (target as any).hits = ((target as any).hits ?? 0) + 1
    this.flash(this.shots)
  }
  @netcall({ to: 'all', reliable: false }) flash(n: number) { this.flashes++ }
  @netcall({ to: 'owner' }) hint(text: string) { this.lastHint = text }
}`;

// The event system over the network: a ring dispatched at the bell on one machine is dispatched at every
// machine's copy of it, once each.
const BELL = `import { Node } from 'cleo'
import { eventDispatch, eventListener } from 'cleo/decorators'
export default class NetBell extends Node {
  rings: string[] = []
  @eventDispatch({ name: 'Rung', to: 'all' }) ring(by: string) { return by }
  @eventListener('Rung') heard(by: string) { this.rings.push(by) }
}`;

const scriptNode = (name: string, id: string, script: string) => ({ type: 'node', name, id, script, position: [0, 0, 0], children: [] });

let w: World;
let a: TestPeer, b: TestPeer;
const players = new Map<number, Node>();
const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];
const named = (scene: Scene, name: string) => [...scene.nodes].find((n) => n.name === name) as any;
/** A peer's Gun: the one in its own Player tree, as seen in `scene`. */
const gunOf = (scene: Scene, owner: TestPeer) => scene.getNodeById(subtree(players.get(owner.session.peerId)!).find((n) => n.name === 'Gun')!.id) as any;

beforeAll(async () => {
    const bin = await packExampleGame(EXAMPLE, {
        edit: (data) => {
            const scene = data.scenes[data.entry].scene;
            scene.children.push(
                scriptNode('Door', 'net-door', DOOR),
                scriptNode('Scoreboard', 'net-scoreboard', SCOREBOARD),
                scriptNode('Pickup', 'net-pickup', PICKUP),
                scriptNode('Bell', 'net-bell', BELL),
            );
            const player = data.templates.find((t: any) => t.name === 'Player');
            player.node.children.push(scriptNode('Gun', 'gun-in-template', GUN));
        },
    });
    w = await world(bin, {
        remote: (runtime) => ({
            possess: (peer) => {
                const root = runtime.scene.instantiate('Player', { position: [30 + peer.id * 5, 0.05, -30] })!;
                players.set(peer.id, root);
                return subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode;
            },
        }),
        scripts: true,
    });
    a = await w.join(LOSSY, 'predict');
    b = await w.join({ ...LOSSY, seed: 13 });
    await w.run(45);
}, 120_000);
afterAll(() => w.dispose());

describe('NetSync phase 7: scripts', () => {
    it('tells each script where it runs: this.net on the host, on a peer, and offline', async () => {
        const hostDoor = named(w.runtime.scene, 'Door');
        expect(hostDoor.net.isHost).toBe(true);
        expect(hostDoor.net.isPeer).toBe(false);
        expect(hostDoor.net.online).toBe(true);
        const peerDoor = named(b.scene, 'Door');
        expect(peerDoor.net.isHost).toBe(false);
        expect(peerDoor.net.isPeer).toBe(true);
        expect(peerDoor.net.peerId).toBe(b.session.peerId);
        // Ownership: A's gun is A's — on the host, on A, and (not B's) on B.
        expect(gunOf(w.runtime.scene, a).net.owner).toBe(a.session.peerId);
        expect(gunOf(a.scene, a).net.isOwner).toBe(true);
        expect(gunOf(b.scene, a).net.isOwner).toBe(false);
        expect(gunOf(w.runtime.scene, a).net.isOwner).toBe(false); // the host does not drive it
        expect(hostDoor.net.isOwner).toBe(true);                   // the host owns what no player does
        // Offline (a scene with no network): its own host.
        const offline = new Scene();
        const lone = offline.root;
        expect(lone.net.isHost).toBe(true);
        expect(lone.net.online).toBe(false);
    });

    it('opens a door any player asks to, and everyone sees it — with the change handler run', async () => {
        named(b.scene, 'Door').toggle(); // B's machine: the @netcall goes to the host
        expect(named(b.scene, 'Door').open).toBe(false); // nothing local: the host decides
        await w.run(15);
        for (const scene of [w.runtime.scene, a.scene, b.scene]) expect(named(scene, 'Door').open).toBe(true);
        expect(named(a.scene, 'Door').swings).toBe(1);
        expect(named(b.scene, 'Door').swings).toBe(1);
        // The field is @observable too: where scripts run (the host, and A, which predicts), setting it there —
        // by the toggle on the host, by the arriving value on A — was heard as 'openChanged'.
        expect(named(w.runtime.scene, 'Door').openings).toBe(1);
        expect(named(a.scene, 'Door').openings).toBe(1);
    });

    it('lets only its owner fire a player’s gun, and tells everyone of the shot', async () => {
        const target = named(w.runtime.scene, 'Door');
        // B tries to fire A's gun: refused (B does not own it).
        gunOf(b.scene, a).fire(named(b.scene, 'Door'));
        await w.run(10);
        expect(gunOf(w.runtime.scene, a).shots).toBe(0);
        const refused = w.scripts!.stats.refused;
        expect(refused).toBe(1);
        // A fires its own, at the door (a node reference, by id).
        gunOf(a.scene, a).fire(named(a.scene, 'Door'));
        await w.run(10);
        expect(gunOf(w.runtime.scene, a).shots).toBe(1);
        expect(target.hits).toBe(1);
        // The host's fire ran flash for all: on the host, and on both peers.
        expect(gunOf(w.runtime.scene, a).flashes).toBe(1);
        expect(gunOf(a.scene, a).flashes).toBe(1);
        expect(gunOf(b.scene, a).flashes).toBe(1);
    });

    it('sends a hint to the owner alone', async () => {
        gunOf(w.runtime.scene, a).hint('reload');
        await w.run(10);
        expect(gunOf(a.scene, a).lastHint).toBe('reload');
        expect(gunOf(b.scene, a).lastHint).toBe('');
        expect(gunOf(w.runtime.scene, a).lastHint).toBe(''); // it ran on A, not on the host
    });

    it('scores a pickup on the host, removes it everywhere, and syncs the board — objects and node references', async () => {
        named(a.scene, 'Pickup').take();
        await w.run(15);
        for (const scene of [w.runtime.scene, a.scene, b.scene]) expect(named(scene, 'Pickup')).toBeFalsy();
        const board = named(w.runtime.scene, 'Scoreboard');
        board.leader = gunOf(w.runtime.scene, a);
        await w.run(10);
        for (const scene of [w.runtime.scene, a.scene, b.scene]) {
            expect(named(scene, 'Scoreboard').scores).toEqual({ [a.session.peerId]: 1 });
            // A node reference arrives as that peer's own copy of the node.
            expect(named(scene, 'Scoreboard').leader).toBe(gunOf(scene, a));
        }
    });

    it('raises a player’s event on the host and on the other players', async () => {
        const heard: string[] = [];
        const off = GameEvents.on('Cheer', (p: any) => heard.push(p.from));
        try {
            named(a.scene, 'Door').net.emit('Cheer', { from: 'A' }, 'all');
            await w.run(10);
            // Once on the host, once on B (the host passes it on), not again on A.
            expect(heard).toEqual(['A', 'A']);
        } finally { off(); }
    });

    it("dispatches an @eventDispatch({ to: 'all' }) at every machine’s copy of the node, once each", async () => {
        // A follow peer (B) runs no scripts, so each machine's copy is listened to by hand as well.
        const machines: [string, Scene][] = [['host', w.runtime.scene], ['A', a.scene], ['B', b.scene]];
        const heard: string[] = [];
        const offs = machines.map(([label, scene]) => named(scene, 'Bell').addEventListener('Rung', (by: string) => heard.push(`${label} heard ${by}`)));
        try {
            named(w.runtime.scene, 'Bell').ring('host');
            await w.run(10);
            expect(heard.sort()).toEqual(['A heard host', 'B heard host', 'host heard host']);
            heard.length = 0;
            // From a player: heard there at once, and on the host and the other player through the host.
            named(a.scene, 'Bell').ring('A');
            await w.run(10);
            expect(heard.sort()).toEqual(['A heard A', 'B heard A', 'host heard A']);
            // The machines that run scripts heard it in the script's own @eventListener too.
            for (const scene of [w.runtime.scene, a.scene]) expect(named(scene, 'Bell').rings).toEqual(['host', 'A']);
        } finally { for (const off of offs) off(); }
    });

    it('gives a late joiner every synced field as it is now', async () => {
        const late = await w.join({ ...LOSSY, seed: 31 });
        await w.run(20);
        expect(named(late.scene, 'Door').open).toBe(true);
        expect(named(late.scene, 'Scoreboard').scores).toEqual({ [a.session.peerId]: 1 });
        expect(named(late.scene, 'Pickup')).toBeFalsy();
    });
});
