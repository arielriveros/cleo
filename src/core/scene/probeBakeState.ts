import type { LightBakeSnapshot, LightNode } from './nodes/lightNode';
import type { LightProbeNode } from './nodes/lightProbeNode';

/**
 * Whether the light probes' bakes still match the lights they baked: what the editor warns about when a
 * light set to bake (LightNode.bake) is moved, recoloured, re-aimed... after the probes were captured.
 * A probe bake stores what each such light was (LightProbeNode.bakedLights); this compares. Pure.
 */

/** What changed about one light since a probe baked it. */
export type LightBakeChange =
    | 'moved' | 'turned' | 'colour' | 'intensity' | 'range' | 'size' | 'cone' | 'shadows' | 'shown'
    | 'added' | 'removed';

export interface StaleLight {
    /** The light, or null when it was deleted (`what` is then 'removed'). */
    light: LightNode | null;
    id: string;
    name: string;
    what: LightBakeChange[];
}

export interface StaleProbe {
    probe: LightProbeNode;
    lights: StaleLight[];
}

/**
 * How far round itself a probe's bake reaches, for which lights count: a bounded probe's half-diagonal and
 * a margin, an unbounded one's wide disc — the numbers its sun shadow is fit to (ShadowPasses.probeShadowRadius).
 */
const PROBE_REACH_MARGIN = 20;
const PROBE_REACH_UNBOUNDED = 300;

export function probeBakeReach(probe: LightProbeNode): number {
    if (!probe.bounded) return PROBE_REACH_UNBOUNDED;
    const s = probe.size, k = probe.worldScale;
    return 0.5 * Math.hypot(s[0] * Math.abs(k[0]), s[1] * Math.abs(k[1]), s[2] * Math.abs(k[2])) + PROBE_REACH_MARGIN;
}

/**
 * Whether a light can matter to a probe's bake: a sun always; a point or spot light when its range reaches
 * the probe's surroundings. A torch across the valley changing does not make the cave's probe out of date.
 */
export function lightReachesProbe(light: LightNode, probe: LightProbeNode): boolean {
    if (light.type === 'directional') return true;
    const p = light.worldPosition, q = probe.worldPosition;
    const range = (light.light as unknown as { range?: number }).range ?? 0;
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) - range < probeBakeReach(probe);
}

/** Below these a change is noise (float drift, a gizmo nudged and put back). */
const POSITION_EPS = 1e-3;
const DIRECTION_EPS = 1e-4;   // 1 - cos, about 0.8 degrees
const RELATIVE_EPS = 1e-4;

/** A light's name, with its parent's for a generic one under a prop ("Torch › Light"). */
export function lightLabel(light: LightNode): string {
    const parent = light.parent;
    return parent && parent.parent ? `${parent.name} › ${light.name}` : light.name;
}

function close(a: number, b: number): boolean {
    return Math.abs(a - b) <= RELATIVE_EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

/** What differs between two snapshots of one light. Empty when nothing a bake depends on did. */
export function lightBakeChanges(then: LightBakeSnapshot, now: LightBakeSnapshot): LightBakeChange[] {
    const out: LightBakeChange[] = [];
    const isSun = now.type === 'directional';
    // A sun's position does not light anything; only where it points does.
    if (!isSun && Math.hypot(now.position[0] - then.position[0], now.position[1] - then.position[1],
                             now.position[2] - then.position[2]) > POSITION_EPS) out.push('moved');
    if (now.type !== 'point') {
        const dot = now.forward[0] * then.forward[0] + now.forward[1] * then.forward[1] + now.forward[2] * then.forward[2];
        if (1 - dot > DIRECTION_EPS) out.push('turned');
    }
    if (!close(now.color[0], then.color[0]) || !close(now.color[1], then.color[1]) || !close(now.color[2], then.color[2])) out.push('colour');
    if (!close(now.intensity, then.intensity)) out.push('intensity');
    if (!close(now.range, then.range)) out.push('range');
    if (!close(now.sourceRadius, then.sourceRadius)) out.push('size');
    if (!close(now.cone[0], then.cone[0]) || !close(now.cone[1], then.cone[1])) out.push('cone');
    // An area light resized, reshaped or made two-sided lights its surroundings differently.
    const a = now.area, b = then.area;
    if ((a === null) !== (b === null) || (a && b && (a.shape !== b.shape || a.twoSided !== b.twoSided
        || !close(a.width, b.width) || !close(a.height, b.height)))) {
        if (!out.includes('size')) out.push('size');
    }
    if (now.castShadows !== then.castShadows) out.push('shadows');
    if (now.shown !== then.shown) out.push('shown');
    return out;
}

/**
 * Every BAKED probe (mode 'baked', baked at least once) whose bake no longer matches the scene's lights:
 * a light set to bake that changed, was added (or set to bake), or is gone (or no longer set to bake).
 * Realtime probes refresh themselves and are never stale.
 */
export function probeBakeStaleness(probes: Iterable<LightProbeNode>, lights: Iterable<LightNode>): StaleProbe[] {
    const current = new Map<string, LightNode>();
    for (const light of lights) if (light.bake) current.set(light.id, light);
    const snapshots = new Map<LightNode, LightBakeSnapshot>();
    const snap = (light: LightNode) => {
        let s = snapshots.get(light);
        if (!s) { s = light.bakeSnapshot(); snapshots.set(light, s); }
        return s;
    };
    const out: StaleProbe[] = [];
    for (const probe of probes) {
        if (probe.mode !== 'baked' || !probe.bakedLights || probe.needsBake || probe.needsRelight) continue;
        const stale: StaleLight[] = [];
        for (const [id, then] of probe.bakedLights) {
            const light = current.get(id);
            if (!light) { stale.push({ light: null, id, name: '', what: ['removed'] }); continue; }
            const what = lightBakeChanges(then, snap(light));
            if (what.length) stale.push({ light, id, name: lightLabel(light), what });
        }
        for (const [id, light] of current)
            if (!probe.bakedLights.has(id) && lightReachesProbe(light, probe)) stale.push({ light, id, name: lightLabel(light), what: ['added'] });
        if (stale.length) out.push({ probe, lights: stale });
    }
    return out;
}

/** "moved", "colour and intensity", "moved, turned and colour": the change words, joined for a sentence. */
export function describeLightChanges(what: readonly LightBakeChange[]): string {
    const words: Record<LightBakeChange, string> = {
        moved: 'moved', turned: 'turned', colour: 'colour changed', intensity: 'intensity changed', range: 'range changed',
        size: 'size changed', cone: 'cone changed', shadows: 'shadows toggled', shown: 'shown or hidden',
        added: 'added', removed: 'removed',
    };
    const list = what.map(w => words[w]);
    if (list.length <= 1) return list[0] ?? '';
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
