// Per-frame scene-update statistics, accumulated during Scene.update() and read via `scene.stats`.
// Imports nothing engine-specific, so scene.ts and the node modules can increment it without a cycle.

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
 * Opt-in per-node timing (`scriptMs` / `animatorMs`). Off by default: it costs two `performance.now()`
 * calls per node per frame, and `nodeLoopMs` brackets those calls, so read `nodeLoopMs` and `frameMs`
 * as inflated while it is on. The coarse split is always collected.
 */
export const sceneStatsDetail = { enabled: false };

/** Zero the per-frame accumulators. `frameMs` and `nodes` are written at the end of update(), so
 *  between frames they hold the last completed values. */
export function resetSceneStats(): void {
    sceneStats.transformMs = 0;
    sceneStats.timerMs = 0;
    sceneStats.nodeLoopMs = 0;
    sceneStats.scriptMs = 0;
    sceneStats.animatorMs = 0;
    sceneStats.rigMs = 0;
    sceneStats.uiMs = 0;
}
