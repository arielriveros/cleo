import type { WaterVolumeNode } from '../../core/scene/nodes/waterVolumeNode';
import type { Scene } from '../../core/scene/scene';
import type { ResolvedWaterShape } from '../../physics/water/waterColumn';
import { groundRegionKey, sceneGround } from '../ground';
import { obstaclesKey, sceneObstacles } from './obstacles';
import type { GroundSampler } from '../waterInfo';
import { groupReach, prepareWaterGroup, type WaterGroupOptions } from './groupSetup';
import { ALL_LAYERS, isAllLayers } from '../../physics/collisionLayers';
import type { WaterBakeSetup } from './shallowWater';

// A Water node's bake, from its scene. A bake covers a GROUP: every water joined to the node through a
// river's Flows from / Flows into, simulated together on one grid (bake/groupSetup.ts), so the current runs
// from a river into its lake, across it and out down the river that drains it. Water that cannot be baked
// (an endless ocean) is not part of any group: it is where a group ends, held at its level, and two rivers
// that reach the same sea are two groups.

const WATERS = (scene: Scene | null): WaterVolumeNode[] => [...((scene as any)?.waterVolumes ?? [])] as WaterVolumeNode[];

/** Whether `node` is water a bake can settle (not an endless ocean). */
export function bakeable(node: WaterVolumeNode): boolean {
    const r = node.resolved();
    return !!r && !(r.type === 'ocean' && r.endless);
}

/**
 * Everything joined to `node` (through any river's Flows from / Flows into, either way) that can be baked:
 * the system one bake simulates. Upstream first: a water after every river that runs into it. Empty for water
 * with nothing to bake.
 */
export function waterBakeGroup(node: WaterVolumeNode): WaterVolumeNode[] {
    if (!bakeable(node)) return [];
    const all = WATERS(node.scene).filter(bakeable);
    const byId = new Map(all.map(n => [n.id, n]));
    const links = new Map<WaterVolumeNode, Set<WaterVolumeNode>>();
    const link = (a: WaterVolumeNode, b: WaterVolumeNode) => {
        (links.get(a) ?? links.set(a, new Set()).get(a)!).add(b);
        (links.get(b) ?? links.set(b, new Set()).get(b)!).add(a);
    };
    for (const n of all) for (const id of [n.flowsFrom, n.flowsInto]) {
        const t = id ? byId.get(id) : undefined;
        if (t && t !== n) link(n, t);
    }
    const group = new Set<WaterVolumeNode>([node]);
    const queue = [node];
    while (queue.length) for (const next of links.get(queue.shift()!) ?? []) if (!group.has(next)) { group.add(next); queue.push(next); }
    // Upstream first: a water waits for the rivers running into it (a loop is broken where it closes).
    const done = new Set<WaterVolumeNode>(), order: WaterVolumeNode[] = [];
    const visit = (n: WaterVolumeNode, path: Set<WaterVolumeNode>) => {
        if (done.has(n) || path.has(n)) return;
        path.add(n);
        for (const up of group) if (up.flowsInto === n.id) visit(up, path);
        path.delete(n);
        done.add(n);
        order.push(n);
    };
    for (const n of group) visit(n, new Set());
    return order;
}

/** The water `group` runs into without including it (the endless sea a river reaches): held at its level. */
export function waterGroupBoundary(group: readonly WaterVolumeNode[]): WaterVolumeNode[] {
    const out: WaterVolumeNode[] = [];
    for (const n of group) for (const t of n.joinedNodes()) if (!group.includes(t) && !out.includes(t)) out.push(t);
    return out;
}

/**
 * The collision layers whose static colliders a bake of `group` meets: every layer any of its waters reacts
 * to (WaterVolumeNode.reactsTo). The setup and the signature both ask this, so a bake made is never stale.
 */
export function waterGroupMask(group: readonly WaterVolumeNode[]): number {
    let mask = 0;
    for (const n of group) {
        const m = n.reactsTo ?? ALL_LAYERS;
        if (isAllLayers(m)) return ALL_LAYERS;
        mask |= m;
    }
    return mask;
}

/** The world rectangle [x0, z0, x1, z1] a bake of `group` can reach. */
export function waterGroupReach(group: readonly WaterVolumeNode[]): number[] | null {
    const bodies: ResolvedWaterShape[] = [];
    for (const n of group) { const r = n.resolved(); if (r) bodies.push(r); }
    return groupReach(bodies);
}

/**
 * The solver's input for the group `node` belongs to, from its scene. `ground` overrides the scene's
 * landscapes (a tool that has the ground but no landscape node). Throws for water with nothing to bake.
 */
export function prepareGroupBake(node: WaterVolumeNode, options: WaterGroupOptions & { ground?: GroundSampler } = {}):
        { setup: WaterBakeSetup; group: WaterVolumeNode[] } {
    const group = waterBakeGroup(node);
    if (!group.length) throw new Error('Nothing to bake: an endless ocean has no flow to settle.');
    const scene = node.scene;
    const ground = options.ground ?? (scene ? sceneGround(scene).sample : null);
    const reach = waterGroupReach(group);
    const obstacles = scene && reach ? sceneObstacles((scene as any).nodes ?? [], reach, waterGroupMask(group)) : [];
    const members = group.map(n => ({ body: n.resolved()!, manning: n.bedRoughness, from: n.flowsFrom, into: n.flowsInto }));
    const boundary = waterGroupBoundary(group).map(n => n.resolved()).filter((r): r is ResolvedWaterShape => !!r);
    return { setup: prepareWaterGroup(members, boundary, ground, obstacles, options), group };
}

/** The ground and obstacles under each group, walked at most twice a second (keyed by the group's first node). */
const CONTEXT = new WeakMap<WaterVolumeNode, { at: number; reach: string; value: string }>();

/** Forget what {@link waterGroupSignature} remembers of the scene round each group. For tests. */
export function forgetWaterBakeContext(): void {
    FORGET.stamp++;
}
const FORGET = { stamp: 0 };
let forgotten = 0;

/**
 * What a bake of the group `node` belongs to depends on: every member's body, placement and bed roughness,
 * the water the group runs into, the ground under it (its content as saved, see ground.ts heightsRegionKey;
 * `groundKey` gives it for a tool with no landscape node) and the static obstacles in reach. One signature
 * for the whole group: editing any member makes every member's bake stale. Content only, so it is the same
 * after a save and a load, and whatever was edited and put back in between.
 */
export function waterGroupSignature(node: WaterVolumeNode, groundKey?: string): string {
    const group = [...waterBakeGroup(node)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!group.length) return '';
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const members = group.map(n => {
        const m = n.worldTransform;
        // The carve settings shape the landscape when its button is pressed, not the water: the ground key
        // says what the ground is now.
        const { carve: _carve, ...body } = n.waterBody as any;
        return [n.id, body, [m[12], m[13], m[14], Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])].map(r), n.bedRoughness];
    });
    const boundary = waterGroupBoundary(group).map(n => { const b = n.resolved(); return [n.id, b ? b.type : '', b ? r(b.level) : 0]; });
    const reach = waterGroupReach(group);
    let context = groundKey ?? '';
    const scene = node.scene;
    if (scene && reach) {
        const leader = group[0];
        const mask = waterGroupMask(group);
        const rect = `${reach.map(r).join(',')}|${mask}`;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (forgotten !== FORGET.stamp) { forgotten = FORGET.stamp; for (const n of WATERS(scene)) CONTEXT.delete(n); }
        const cached = groundKey === undefined ? CONTEXT.get(leader) : undefined;
        if (cached && cached.reach === rect && now - cached.at < 500) context = cached.value;
        else {
            const ground = groundKey ?? groundRegionKey(scene, reach);
            context = `${ground}|${obstaclesKey(sceneObstacles((scene as any).nodes ?? [], reach, mask))}`;
            if (groundKey === undefined) CONTEXT.set(leader, { at: now, reach: rect, value: context });
        }
    }
    return JSON.stringify([members, boundary, context]);
}
