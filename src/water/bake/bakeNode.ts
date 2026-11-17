import type { WaterVolumeNode } from '../../core/scene/nodes/waterVolumeNode';
import type { Scene } from '../../core/scene/scene';
import { groundRegionKey, sceneGround } from '../ground';
import { obstaclesKey, sceneObstacles } from './obstacles';
import type { GroundSampler } from '../waterInfo';
import { prepareWaterBake, riverDischarge, type PrepareOptions, type WaterBakeSetup, type WaterInflow, type WaterOutflow } from './shallowWater';

// A Water node's bake, from its scene: the ground under it, the static obstacles in it, the water it joins,
// and the rivers that run into it or out of it. And the GROUP a bake covers: everything joined to the node,
// baked upstream first (a lake after the rivers that feed it).

const WATERS = (scene: Scene | null): WaterVolumeNode[] => [...((scene as any)?.waterVolumes ?? [])] as WaterVolumeNode[];

/** The world rectangle [x0, z0, x1, z1] a node's bake can reach (its body and the bank margin). */
export function bakeReach(node: WaterVolumeNode): number[] | null {
    const r = node.resolved();
    if (!r || (r.type === 'ocean' && r.endless)) return null;
    const widest = r.type === 'river' ? Math.max(1, ...r.samples.map(s => s.width)) : 0;
    const m = Math.max(4, widest) + 2;
    return [r.min[0] - m, r.min[2] - m, r.max[0] + m, r.max[2] + m];
}

/** The rivers running into `node` (their mouths and discharge), and out of it (their heads). */
function flowsOf(node: WaterVolumeNode): { inflows: WaterInflow[]; outflows: WaterOutflow[]; keys: string[] } {
    const inflows: WaterInflow[] = [], outflows: WaterOutflow[] = [], keys: string[] = [];
    for (const other of WATERS(node.scene)) {
        if (other === node || other.waterType !== 'river') continue;
        const r = other.resolved();
        if (!r || !r.samples.length) continue;
        if (other.flowsInto === node.id) {
            const last = r.samples[r.samples.length - 1];
            inflows.push({ x: last.x, z: last.z, radius: last.width / 2, discharge: riverDischarge(last) });
            keys.push(`in:${other.resolveKey()}`);
        }
        if (other.flowsFrom === node.id) {
            const first = r.samples[0];
            outflows.push({ x: first.x, z: first.z, radius: first.width / 2 });
            keys.push(`out:${other.resolveKey()}`);
        }
    }
    return { inflows, outflows, keys };
}

/**
 * What a bake of `node` depends on in its scene beyond its own body: the ground under it (its content as
 * saved, see ground.ts heightsRegionKey; `groundKey` gives it for a tool with no landscape node), the static
 * obstacles in reach, and the rivers running into or out of it. Part of WaterVolumeNode.bakeSignature.
 */
export function waterBakeContext(node: WaterVolumeNode, groundKey?: string): string {
    const scene = node.scene;
    if (!scene) return groundKey ?? '';
    const reach = bakeReach(node);
    const ground = groundKey ?? (reach ? groundRegionKey(scene, reach) : '');
    const obstacles = reach ? obstaclesKey(sceneObstacles((scene as any).nodes ?? [], reach)) : '';
    return `${ground}|${obstacles}|${flowsOf(node).keys.join(',')}`;
}

/**
 * The solver's input for `node` from its scene (prepareWaterBake). `ground` overrides the scene's landscapes
 * (a tool that has the ground but no landscape node). Throws for water with nothing to bake.
 */
export function prepareNodeBake(node: WaterVolumeNode, options: Omit<PrepareOptions, 'inflows' | 'outflows'> & { ground?: GroundSampler } = {}): WaterBakeSetup {
    const body = node.resolved();
    if (!body) throw new Error('Nothing to bake: the water has no shape.');
    const scene = node.scene;
    const ground = options.ground ?? (scene ? sceneGround(scene).sample : null);
    const reach = bakeReach(node);
    const obstacles = scene && reach ? sceneObstacles((scene as any).nodes ?? [], reach) : [];
    const { inflows, outflows } = flowsOf(node);
    return prepareWaterBake(body, node.handOver(), ground, obstacles, { manning: node.bedRoughness, ...options, inflows, outflows });
}

/** Whether `node` is water a bake can settle (not an endless ocean). */
export function bakeable(node: WaterVolumeNode): boolean {
    const r = node.resolved();
    return !!r && !(r.type === 'ocean' && r.endless);
}

/**
 * Everything joined to `node` (through any river's Flows from / Flows into, either way) that can be baked,
 * in the order to bake it: a water after every river that runs into it, so its inflow is settled first.
 */
export function waterBakeGroup(node: WaterVolumeNode): WaterVolumeNode[] {
    const all = WATERS(node.scene);
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
    return order.filter(bakeable);
}
