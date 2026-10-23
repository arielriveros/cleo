/**
 * Occlusion culling, stage two: hardware occlusion queries against the frame's real depth.
 *
 * Stage one (graphics/occlusion) rasterizes a few conservative occluders on the CPU — the terrain and
 * authored Occluder volumes — so it can never know that a house hides the cart behind it, or a cliff the
 * camp below it unless the cliff is terrain. This asks the GPU instead. After the geometry pass, each
 * candidate node's bounding box is drawn against the depth buffer, no colour and no depth write, inside an
 * occlusion query; a box with no sample passing is hidden behind whatever IS drawn, and the node is
 * skipped until a later query says otherwise.
 *
 * ## The catch, and how it is contained
 *
 * Results come back a frame or more later (no readback ever waits), so a verdict describes the view as it
 * was. Three rules keep that from showing:
 *
 * - **Only "hidden" is acted on, and only while fresh.** No result, or one older than {@link MAX_AGE}
 *   frames, means visible. A node is never skipped on a guess.
 * - **Hidden nodes are queried every frame**, so the moment one is uncovered the next result says so.
 *   The box is inflated a little, so a node about to come into view is already reported visible.
 * - **A camera cut forgets everything** — a jump or a fast turn makes every old verdict wrong at once.
 *
 * What remains is a frame or two of a node appearing late when something that hid it moves away fast;
 * the same trade every engine that reads queries back makes.
 *
 * Only nodes worth a query are asked about: big or heavy ones. A query costs a draw; for a small cheap
 * mesh the draw it might save is no dearer than the box.
 */

import { vec3 } from 'gl-matrix';
import type { OcclusionQuerySet } from './rhi/resources';
import type { ModelNode } from '../core/scene/nodes/modelNode';

/** Queries per frame, at most. */
export const GPU_OCCLUSION_BUDGET = 512;
/** A "hidden" verdict older than this many frames no longer hides anything. */
export const MAX_AGE = 4;
/** Below these a node is not worth a query: bounding radius (m), and triangles. */
export const MIN_RADIUS = 1.5;
export const MIN_TRIANGLES = 1500;
/** Camera motion in one frame that counts as a cut: metres, and degrees of turn. */
export const CUT_DISTANCE = 4;
export const CUT_ANGLE = 30;

interface Verdict { frame: number; hidden: boolean }

export class GpuOcclusion {
    private _frame = 0;
    /** The nodes queried in each submitted frame, by query index. */
    private readonly _pending = new Map<number, ModelNode[]>();
    private readonly _verdicts = new WeakMap<ModelNode, Verdict>();
    /** This frame's candidates, in query order. */
    public readonly candidates: ModelNode[] = [];
    private readonly _candidateSet = new Set<ModelNode>();
    private readonly _lastEye = vec3.fromValues(NaN, NaN, NaN);
    private readonly _lastForward = vec3.fromValues(0, 0, -1);
    /** Nodes hidden by a fresh verdict this frame, for the HUD. */
    public hiddenThisFrame = 0;

    /**
     * Start a frame: take whatever results have arrived, and forget everything on a camera cut. `eye` and
     * `forward` are the camera's world position and unit view direction.
     */
    public beginFrame(set: OcclusionQuerySet | null, eye: ArrayLike<number>, forward: ArrayLike<number>): void {
        this._frame++;
        this.candidates.length = 0;
        this._candidateSet.clear();
        this.hiddenThisFrame = 0;

        const moved = vec3.distance(this._lastEye, eye as vec3);
        const cos = vec3.dot(this._lastForward, forward as vec3);
        const cut = !(moved < CUT_DISTANCE) || cos < Math.cos(CUT_ANGLE * Math.PI / 180);
        vec3.copy(this._lastEye, eye as vec3);
        vec3.copy(this._lastForward, forward as vec3);
        if (cut) this._forget();

        if (!set) return;
        for (let result = set.poll(); result; result = set.poll()) {
            const nodes = this._pending.get(result.tag);
            if (!nodes) continue;
            this._pending.delete(result.tag);
            // A result from before the cut describes a view that no longer exists.
            if (cut) continue;
            const n = Math.min(nodes.length, result.count);
            for (let i = 0; i < n; i++)
                this._verdicts.set(nodes[i], { frame: result.tag, hidden: result.visible[i] === 0 });
        }
        // Submissions whose results will never come (a lost device, a dropped readback) are not kept.
        for (const tag of this._pending.keys()) if (this._frame - tag > MAX_AGE * 4) this._pending.delete(tag);
    }

    /** Whether a fresh query found `node` hidden. Never true without one. */
    public isHidden(node: ModelNode): boolean {
        const v = this._verdicts.get(node);
        const hidden = !!v && v.hidden && this._frame - v.frame <= MAX_AGE;
        if (hidden) this.hiddenThisFrame++;
        return hidden;
    }

    /**
     * Offer a node that passed every other test (or failed only this one) for a query this frame. Returns
     * whether it was taken. Small, cheap nodes are refused, as is anything past the budget.
     */
    public consider(node: ModelNode, radius: number, triangles: number): boolean {
        if (this.candidates.length >= GPU_OCCLUSION_BUDGET || this._candidateSet.has(node)) return false;
        if (radius < MIN_RADIUS && triangles < MIN_TRIANGLES) return false;
        this._candidateSet.add(node);
        this.candidates.push(node);
        return true;
    }

    /** Record that this frame's queries were resolved under `tag` (the frame), for {@link beginFrame}. */
    public submitted(): number {
        this._pending.set(this._frame, this.candidates.slice());
        return this._frame;
    }

    /** Forget every verdict: the view changed too much for any of them to hold. */
    private _forget(): void {
        // A WeakMap cannot be cleared; a verdict is only trusted inside MAX_AGE, so moving the clock past
        // every live one has the same effect.
        this._frame += MAX_AGE + 1;
    }

    public get frame(): number { return this._frame; }
}
