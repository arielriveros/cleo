// Per-frame scene-update statistics, accumulated during Scene.update() and read by the editor's
// performance HUD via `scene.stats`. Standalone (imports nothing engine-specific) so scene.ts and
// node.ts can both increment it without a circular import — same arrangement as renderStats.ts and
// physicsStats.ts.
//
// This covers the slice of the frame that nothing else measured: everything between physics and
// render. `frame - render - physics` used to be a single opaque number; these fields say whether it
// is user scripts, skinned-mesh animation, transform propagation, or camera rigs.

export interface SceneStats {
    /** `_root.updateTransforms()` — both passes, including the extra one camera rigs force. */
    transformMs: number;
    /** `this.after`/`this.every` callbacks fired this frame. */
    timerMs: number;
    /** The whole per-node loop: scripts, animators and each node type's own update work. */
    nodeLoopMs: number;
    /** Subset of nodeLoopMs spent in user `onUpdate` handlers. */
    scriptMs: number;
    /** Subset of nodeLoopMs spent driving skinned-mesh animators. */
    animatorMs: number;
    /** Camera-rig late pass, excluding the transform pass it triggers (counted in transformMs). */
    rigMs: number;
    /** UI layout late pass: resolving every UI root's subtree into screen rects. */
    uiMs: number;
    /** Nodes walked this frame. */
    nodes: number;
    /** UI elements resolved this frame. */
    uiNodes: number;
    /** Everything inside Scene.update(). */
    frameMs: number;
}

export const sceneStats: SceneStats = {
    transformMs: 0,
    timerMs: 0,
    nodeLoopMs: 0,
    scriptMs: 0,
    animatorMs: 0,
    rigMs: 0,
    uiMs: 0,
    nodes: 0,
    uiNodes: 0,
    frameMs: 0,
};

/**
 * Opt-in per-node timing (`scriptMs` / `animatorMs`). **Off by default, deliberately.**
 *
 * It costs two `performance.now()` calls per node per frame — measured at ~240ns per node, i.e.
 * +0.12ms/frame over 500 nodes and +0.44ms over 2000. Against a 16ms budget that is small, but
 * against `Scene.update` itself it is 50-160%, and since `nodeLoopMs` brackets those calls the
 * detail pass inflates the very totals it is attributing. Leaving it on would make the coarse
 * numbers lie.
 *
 * So: the coarse split (transforms / timers / node loop / rigs) is always collected and costs a
 * handful of calls per frame; turn this on only while you specifically want the script-vs-animator
 * breakdown, and read `nodeLoopMs`/`frameMs` as inflated while it is on. The editor's performance
 * panel exposes it as a toggle.
 */
export const sceneStatsDetail = { enabled: false };

/** Zero the per-frame accumulators. `frameMs` and `nodes` are written at the end of update(), so
 *  between frames they hold the last completed values (same convention as resetFrameStats). */
export function resetSceneStats(): void {
    sceneStats.transformMs = 0;
    sceneStats.timerMs = 0;
    sceneStats.nodeLoopMs = 0;
    sceneStats.scriptMs = 0;
    sceneStats.animatorMs = 0;
    sceneStats.rigMs = 0;
    sceneStats.uiMs = 0;
}
