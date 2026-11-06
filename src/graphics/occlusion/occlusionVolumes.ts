/**
 * Occlusion volumes (OcclusionVolumeNode): boxes whose CONTENTS are skipped while the box itself cannot
 * be seen. The decision, once per frame for the main view, with nothing GPU- or scene-specific in it so
 * the tests can drive it directly; graphics/render/visibility.ts feeds it the scene and acts on the answer.
 *
 * ## Why it is exact
 *
 * A node belongs to a volume only if its whole world bounds lie inside the box (a light: its position).
 * If no point of the box can be seen — every one is outside the frustum, or behind the landscape, or
 * behind the depth the frame drew — then no point of anything inside it can be seen either. So hiding
 * the contents never hides something visible; the only loss is the latency of the GPU query (below).
 *
 * ## Which test, in order
 *
 * 1. The eye inside the box (a margin wider than the near plane): seen. Never queried — the near plane
 *    would clip its faces and the query could report nothing.
 * 2. The oriented box outside the frustum: not seen. Same frame, exact.
 * 3. Its world box hidden behind the CPU occlusion buffer (the landscape): not seen. Same frame.
 * 4. Otherwise it is offered for a GPU occlusion query, and is not seen only on a FRESH "hidden" verdict
 *    (graphics/gpuOcclusion.ts: never on a guess, forgotten on a camera cut). A box coming into view past
 *    a door frame therefore shows its contents a frame or two late — the trade every engine that reads
 *    occlusion queries back makes.
 *
 * ## What it costs
 *
 * Membership is cached per node and re-tested only when the node's bounds may have changed (its
 * {@link VolumeContentSource.version}) or a volume changed. A still scene pays a map lookup and a compare
 * per content node per frame, and nothing at all while it has no enabled volume. A volume with nothing
 * inside it is never tested, so it never spends a query.
 */

import { mat4, vec3 } from 'gl-matrix';
import type { OcclusionVolumeCull } from '../../core/scene/nodes/occlusionVolumeNode';

/** The kinds of content a volume can hide; `shadows` is a property of `models`, not a kind. */
export type VolumeContentKind = Exclude<keyof OcclusionVolumeCull, 'shadows'>;

/** What the decision reads of a volume. OcclusionVolumeNode is one. */
export interface VolumeLike {
    readonly enabled: boolean;
    readonly visible: boolean;
    /** Full extents, local units, centred on the node. */
    readonly size: ArrayLike<number>;
    readonly worldTransform: ArrayLike<number>;
    /** Changes whenever `worldTransform` does. */
    readonly transformVersion: number;
    /** Changes whenever `size` or a cull switch does. */
    readonly version: number;
    culls(key: keyof OcclusionVolumeCull): boolean;
}

/** One kind of content and the nodes of it, with how to read their bounds. */
export interface VolumeContentSource<T extends object = object> {
    readonly kind: VolumeContentKind;
    /** Re-pointed by the caller each frame (the scene's lists are reallocated when they rebuild). */
    nodes: Iterable<T>;
    /**
     * Changes whenever the node's bounds may have; NaN re-tests it every frame (for content whose bounds
     * follow parameters rather than the transform).
     */
    version(node: T): number;
    /**
     * An object whose identity changing also means new bounds (a model's geometry), or null.
     */
    ref?(node: T): object | null;
    /**
     * Write the node's world AABB (for a point, min = max) and return true; false when the node never
     * belongs to a volume (editor chrome, terrain chunks, a sun, no bounds).
     */
    bounds(node: T, min: vec3, max: vec3): boolean;
}

/** A GPU occlusion query, offered per volume: graphics/gpuOcclusion.ts behind it. */
export interface VolumeQueries {
    /** Offer `volume` for this frame's queries, tested as the unit cube under `box`. Whether it was taken. */
    consider(volume: VolumeLike, box: mat4): boolean;
    /** Whether a fresh query found it hidden. */
    isHidden(volume: VolumeLike): boolean;
}

export interface VolumeFrameInput {
    readonly volumes: Iterable<VolumeLike>;
    readonly sources: readonly VolumeContentSource<any>[];
    /** The camera's world position, and its near plane distance. */
    readonly eye: ArrayLike<number>;
    readonly near: number;
    /** The view frustum's 6 normalized planes, (a, b, c, d) each (Frustum.planes); null = no frustum test. */
    readonly planes: ArrayLike<number> | null;
    /** Whether a world AABB is hidden behind the CPU occlusion buffer; null = no buffer this frame. */
    readonly cpuOccluded: ((min: ArrayLike<number>, max: ArrayLike<number>) => boolean) | null;
    /** null = no queries this frame (forward pipeline, no device support, queries off). */
    readonly queries: VolumeQueries | null;
    /** Never hidden, whatever its volume does: the editor's selected node, which the outline redraws. */
    readonly exempt?: object | null;
}

/** This frame's counters, for the HUD. */
export interface VolumeFrameStats {
    /** Enabled volumes with something inside, whose visibility was decided. */
    tested: number;
    /** Of those, the ones that could not be seen. */
    hidden: number;
    /** Of those, the ones a GPU query found hidden (the rest by frustum or landscape). */
    queryHidden: number;
    /** Content nodes hidden by a volume this frame, all kinds. */
    culledNodes: number;
}

/** Extra room around the near plane for the eye-inside test, metres. */
const EYE_MARGIN = 0.1;

interface VolumeState {
    readonly volume: VolumeLike;
    transformVersion: number;
    version: number;
    /** World -> the box's unit cube (inside = every |coordinate| <= 0.5), or null when degenerate. */
    readonly inv: mat4;
    /** The unit cube -> world: the box itself. */
    readonly box: mat4;
    degenerate: boolean;
    /** The box's world AABB, for the broad phase and the CPU buffer. */
    readonly min: vec3;
    readonly max: vec3;
    /** Its world length along each local axis, for the eye margin. */
    readonly lengths: vec3;
    /** This frame's contents: node, kind index. */
    readonly members: object[];
    readonly kinds: number[];
    seen: number;
    /** This frame's answer: the camera could not see it. */
    hidden: boolean;
}

interface Membership {
    version: number;
    ref: object | null;
    epoch: number;
    /** The volumes the node lies inside, or null for none. */
    states: VolumeState[] | null;
}

const KIND_INDEX: Record<VolumeContentKind, number> = { models: 0, sprites: 1, particles: 2, lights: 3, decals: 4, fluids: 5 };
const KINDS: VolumeContentKind[] = ['models', 'sprites', 'particles', 'lights', 'decals', 'fluids'];

export class OcclusionVolumes {
    /** Content hidden from the camera passes this frame. */
    public readonly hidden = new Set<object>();
    /** Models that also cast no shadow this frame (their volume's `shadows` switch). */
    public readonly shadowHidden = new Set<object>();
    public readonly stats: VolumeFrameStats = { tested: 0, hidden: 0, queryHidden: 0, culledNodes: 0 };

    private readonly _states = new Map<VolumeLike, VolumeState>();
    private readonly _active: VolumeState[] = [];
    private readonly _membership = new WeakMap<object, Membership>();
    /** Bumped whenever the set of volumes or any volume's box changes: every membership is then stale. */
    private _epoch = 0;
    private _frame = 0;
    /** Whether the last call was a real decision (not a {@link clear}), so {@link status} means something. */
    private _answered = false;
    private readonly _min = vec3.create();
    private readonly _max = vec3.create();
    private readonly _scratch = vec3.create();

    /** Forget this frame's answer: nothing hidden (a frame with volumes off, a capture). */
    public clear(): void {
        this._answered = false;
        this.hidden.clear();
        this.shadowHidden.clear();
        this.stats.tested = this.stats.hidden = this.stats.queryHidden = this.stats.culledNodes = 0;
    }

    /** Decide this frame: which volumes cannot be seen, and so which content is hidden. */
    public update(input: VolumeFrameInput): void {
        this.clear();
        this._frame++;
        this._answered = true;
        if (!this._collectVolumes(input.volumes)) return;

        // Every content node: its volumes (cached), and into each one's member list for this frame.
        const min = this._min, max = this._max;
        for (const source of input.sources) {
            const kind = KIND_INDEX[source.kind];
            for (const node of source.nodes) {
                let m = this._membership.get(node);
                const version = source.version(node);
                const ref = source.ref ? source.ref(node) : null;
                if (!m || m.epoch !== this._epoch || m.version !== version || m.ref !== ref) {
                    if (!m) { m = { version, ref, epoch: this._epoch, states: null }; this._membership.set(node, m); }
                    m.version = version; m.ref = ref; m.epoch = this._epoch;
                    m.states = source.bounds(node, min, max) ? this._containing(min, max, m.states) : null;
                }
                const states = m.states;
                if (!states) continue;
                for (let i = 0; i < states.length; i++) { states[i].members.push(node); states[i].kinds.push(kind); }
            }
        }

        // Each volume with something inside: can the camera see it?
        for (const state of this._active) {
            state.hidden = false;
            if (state.members.length === 0) continue;
            this.stats.tested++;
            if (this._seen(state, input)) continue;
            state.hidden = true;
            this.stats.hidden++;
            const volume = state.volume;
            const shadows = volume.culls('shadows');
            const members = state.members, kinds = state.kinds;
            for (let i = 0; i < members.length; i++) {
                const node = members[i];
                if (node === input.exempt) continue;
                const kind = kinds[i];
                if (volume.culls(KINDS[kind]) && !this.hidden.has(node)) { this.hidden.add(node); this.stats.culledNodes++; }
                if (kind === 0 && shadows) this.shadowHidden.add(node);
            }
        }
    }

    /**
     * What the last decision found for `volume`, for the inspector: how many nodes lie inside it, and
     * whether the camera could not see it. Null when there was no decision (volumes off, a capture), or the
     * volume took no part in it (disabled, hidden, no size).
     */
    public status(volume: VolumeLike): { inside: number; hidden: boolean } | null {
        if (!this._answered) return null;
        const state = this._states.get(volume);
        if (!state || state.seen !== this._frame || state.degenerate) return null;
        return { inside: state.members.length, hidden: state.hidden };
    }

    /** The enabled volumes into `_active`, their boxes refreshed. False when there are none. */
    private _collectVolumes(volumes: Iterable<VolumeLike>): boolean {
        const active = this._active;
        const before = active.length;
        let changed = false, n = 0;
        for (const volume of volumes) {
            if (!volume.enabled || !volume.visible) continue;
            let state = this._states.get(volume);
            if (!state) {
                state = {
                    volume, transformVersion: NaN, version: NaN, inv: mat4.create(), box: mat4.create(), degenerate: true,
                    min: vec3.create(), max: vec3.create(), lengths: vec3.create(), members: [], kinds: [], seen: 0, hidden: false,
                };
                this._states.set(volume, state);
            }
            if (state.transformVersion !== volume.transformVersion || state.version !== volume.version) {
                this._refreshBox(state);
                changed = true;
            }
            state.seen = this._frame;
            state.members.length = 0;
            state.kinds.length = 0;
            if (state.degenerate) continue;
            if (active[n] !== state) { active[n] = state; changed = true; }
            n++;
        }
        if (n !== before) changed = true;
        active.length = n;
        // A volume removed or disabled leaves its state behind; drop the ones not seen for a while.
        if (this._frame % 120 === 0)
            for (const [volume, state] of this._states) if (this._frame - state.seen > 120) this._states.delete(volume);
        if (changed) this._epoch++;
        return n > 0;
    }

    private _refreshBox(state: VolumeState): void {
        const v = state.volume;
        state.transformVersion = v.transformVersion;
        state.version = v.version;
        const size = v.size;
        mat4.scale(state.box, v.worldTransform as mat4, [size[0], size[1], size[2]]);
        const b = state.box;
        for (let a = 0; a < 3; a++) state.lengths[a] = Math.hypot(b[a * 4], b[a * 4 + 1], b[a * 4 + 2]);
        state.degenerate = !(size[0] > 0 && size[1] > 0 && size[2] > 0) || !mat4.invert(state.inv, b)
            || !(state.lengths[0] > 1e-6 && state.lengths[1] > 1e-6 && state.lengths[2] > 1e-6);
        // World AABB: centre ± the absolute half-axes.
        for (let r = 0; r < 3; r++) {
            const c = b[12 + r];
            const h = 0.5 * (Math.abs(b[r]) + Math.abs(b[4 + r]) + Math.abs(b[8 + r]));
            state.min[r] = c - h;
            state.max[r] = c + h;
        }
    }

    /** The active volumes `[min, max]` lies entirely inside, reusing `out`; null for none. */
    private _containing(min: vec3, max: vec3, out: VolumeState[] | null): VolumeState[] | null {
        if (out) out.length = 0;
        const c = this._scratch;
        for (const state of this._active) {
            // Broad phase: inside the box means inside its world AABB.
            if (min[0] < state.min[0] || min[1] < state.min[1] || min[2] < state.min[2]
                || max[0] > state.max[0] || max[1] > state.max[1] || max[2] > state.max[2]) continue;
            // The AABB's centre and half extents into the unit cube: |centre| + |A|·half <= 0.5 per axis.
            const m = state.inv;
            const ex = (max[0] - min[0]) * 0.5, ey = (max[1] - min[1]) * 0.5, ez = (max[2] - min[2]) * 0.5;
            vec3.set(c, min[0] + ex, min[1] + ey, min[2] + ez);
            vec3.transformMat4(c, c, m);
            let inside = true;
            for (let a = 0; a < 3 && inside; a++) {
                const reach = Math.abs(m[a]) * ex + Math.abs(m[4 + a]) * ey + Math.abs(m[8 + a]) * ez;
                inside = Math.abs(c[a]) + reach <= 0.5;
            }
            if (!inside) continue;
            (out ??= []).push(state);
        }
        return out && out.length > 0 ? out : null;
    }

    /** Whether the camera can see any of the volume's box. See the header for the order. */
    private _seen(state: VolumeState, input: VolumeFrameInput): boolean {
        const b = state.box;
        // 1. The eye inside (in the unit cube, the margin per axis is its world size over the axis length).
        const e = vec3.transformMat4(this._scratch, input.eye as vec3, state.inv);
        const margin = Math.max(0, input.near) + EYE_MARGIN;
        if (Math.abs(e[0]) <= 0.5 + margin / state.lengths[0] && Math.abs(e[1]) <= 0.5 + margin / state.lengths[1]
            && Math.abs(e[2]) <= 0.5 + margin / state.lengths[2]) return true;
        // 2. The frustum: the box's projected radius on each plane's normal against its centre's distance.
        const p = input.planes;
        if (p) {
            for (let i = 0; i < 6; i++) {
                const o = i * 4, a = p[o], bb = p[o + 1], c = p[o + 2];
                const dist = a * b[12] + bb * b[13] + c * b[14] + p[o + 3];
                const r = 0.5 * (Math.abs(a * b[0] + bb * b[1] + c * b[2])
                               + Math.abs(a * b[4] + bb * b[5] + c * b[6])
                               + Math.abs(a * b[8] + bb * b[9] + c * b[10]));
                if (dist < -r) return false;
            }
        }
        // 3. The landscape.
        if (input.cpuOccluded && input.cpuOccluded(state.min, state.max)) return false;
        // 4. Whatever the frame drew: offered every frame, so a hidden box is found again the moment it is not.
        const q = input.queries;
        if (q && q.consider(state.volume, state.box) && q.isHidden(state.volume)) {
            this.stats.queryHidden++;
            return false;
        }
        return true;
    }
}
