import type { LightProbeNode } from '../../core/scene/nodes/lightProbeNode';

/**
 * Light probe bakes, TIME-SLICED: a bake is a job of small steps, one step a frame, one job at a time, so
 * no frame pays for a whole capture. The probe keeps the maps and the atlas layer it had until its job's
 * last step swaps the new ones in.
 *
 * A probe is RELIGHTABLE: a full bake captures its scene once as a G-buffer (one face a step), and a
 * relight lights that G-buffer again (the sun moved, a light changed) without drawing any geometry but the
 * sun's shadow — what a time of day needs (the Far Cry / Assassin's Creed / Frostbite practice).
 *
 * Pure, so the order and the steps are tested without a device.
 */

/**
 * One step of a probe job. Every step is one frame's work, but 'gbuffer' is the capture of all six faces,
 * spread over as many frames as its draw budget needs (ProbeBaker: `GBUFFER_DRAWS_PER_FRAME`).
 */
export type ProbeJobStep =
    | { kind: 'gbuffer' }                              // capture the six faces' G-buffers (bake only)
    | { kind: 'shadow' }                               // the probe's sun shadow map
    | { kind: 'relight' }                              // light the six faces into the source cube
    | { kind: 'filter'; mips: readonly number[]; finish: boolean };   // prefilter into the atlas; last: swap in

export type ProbeJobKind = 'bake' | 'relight' | 'filter';

/** The steps of one job, in order. */
export function probeJobSteps(kind: ProbeJobKind): ProbeJobStep[] {
    const steps: ProbeJobStep[] = [];
    if (kind === 'bake') steps.push({ kind: 'gbuffer' });
    if (kind !== 'filter') {
        steps.push({ kind: 'shadow' });
        steps.push({ kind: 'relight' });
    }
    // The source cube's mips and the mirror level first, then mip 1 (roughness 0.25 at 128 px) on its own,
    // most of the filter's GPU time, then the rest, which together cost about a third of it.
    steps.push({ kind: 'filter', mips: [0], finish: false });
    steps.push({ kind: 'filter', mips: [1], finish: false });
    steps.push({ kind: 'filter', mips: [2, 3, 4], finish: true });
    return steps;
}

export interface ProbeJobChoice { probe: LightProbeNode; kind: ProbeJobKind }

/**
 * The next probe job: of the probes that need one, the most urgent, nearest the camera within a tier.
 *  0. never baked (it lights nothing until it is): a bake;
 *  1. baked, but with no reflection in the atlas (the atlas was regrown): a filter;
 *  2. a bake asked for (the Bake button, a resolution change): a bake;
 *  3. a relight asked for (a time of day, a light changed): a relight, or a bake when no G-buffer exists;
 *  4. a realtime probe due its refresh: a bake (it exists to see moving things).
 * `hasGBuffer` says whether a probe's scene is captured and still valid.
 */
export function nextProbeJob(probes: Iterable<LightProbeNode>, camera: ArrayLike<number>, now: number,
                             hasGBuffer: (probe: LightProbeNode) => boolean): ProbeJobChoice | null {
    let best: ProbeJobChoice | null = null;
    let bestTier = Infinity;
    let bestDistance = Infinity;
    for (const probe of probes) {
        let tier: number;
        let kind: ProbeJobKind;
        const due = probe.mode === 'realtime' && (now - probe.lastBakeTime) >= probe.updateFrequency * 1000;
        if (!probe.hasBakedMaps) { tier = 0; kind = 'bake'; }
        else if (probe.affectsReflections && probe.reflectionLayer < 0) { tier = 1; kind = 'filter'; }
        else if (probe.needsBake) { tier = 2; kind = 'bake'; }
        else if (probe.needsRelight) { tier = 3; kind = hasGBuffer(probe) ? 'relight' : 'bake'; }
        else if (due) { tier = 4; kind = 'bake'; }
        else continue;
        const p = probe.worldPosition;
        const d = (p[0] - camera[0]) ** 2 + (p[1] - camera[1]) ** 2 + (p[2] - camera[2]) ** 2;
        if (tier < bestTier || (tier === bestTier && d < bestDistance)) {
            best = { probe, kind }; bestTier = tier; bestDistance = d;
        }
    }
    return best;
}

/** What `probesToRelightForSun` needs of a probe. */
export interface SunFollowingProbe {
    readonly relightDegrees: number;
    readonly hasBakedMaps: boolean;
}

/**
 * The probes the sun has turned far enough for to relight themselves (`LightProbeNode.relightDegrees`), given
 * the direction the sun now travels in and the one each probe was last lit with (`litWith`, updated here).
 * A probe seen for the first time, or not yet baked, only records the direction: its bake lights it anyway.
 */
export function probesToRelightForSun<P extends SunFollowingProbe>(probes: Iterable<P>, sunDir: ArrayLike<number> | null,
                                                                    litWith: WeakMap<P, [number, number, number]>): P[] {
    if (!sunDir) return [];
    const len = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
    const d: [number, number, number] = [sunDir[0] / len, sunDir[1] / len, sunDir[2] / len];
    const out: P[] = [];
    for (const probe of probes) {
        if (!(probe.relightDegrees > 0)) continue;
        const last = litWith.get(probe);
        if (!last || !probe.hasBakedMaps) { litWith.set(probe, d); continue; }
        const cos = Math.min(1, Math.max(-1, last[0] * d[0] + last[1] * d[1] + last[2] * d[2]));
        if (Math.acos(cos) * 180 / Math.PI <= probe.relightDegrees) continue;
        litWith.set(probe, d);
        out.push(probe);
    }
    return out;
}
