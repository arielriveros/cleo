import { vec3 } from "gl-matrix";
import { aiStats } from "./aiStats";
import type { CleoNavMesh } from "./navMesh";

/**
 * The navigation service: which navmesh answers a query, and how long the query took.
 *
 * ## Where it lives, and why that took a correction
 *
 * Owned by `CleoEngine`, not by `Scene` — the same shape as `PhysicsSystem`, which is easy to get
 * wrong because `Scene.physics` looks like ownership and is only a back-pointer written by the
 * system's own `scene` setter. Getting it backwards matters for one specific reason: that setter also
 * **clears**. The editor calls `setScene` on every tab switch, and a system that kept per-scene state
 * across those would leak an agent's route into the next scene it was handed.
 *
 * ## Why this one IS testable, unlike PhysicsSystem
 *
 * Every import here is either gl-matrix or type-only. `physicsSystem.ts` reaches the cleo barrel and
 * therefore cannot be unit-tested at all, which is why `cameraRayFilter.ts` had to be split out of it.
 * Keeping `Scene` and `NavMeshNode` as `import type` avoids inheriting that problem — the structural
 * shapes below are all this needs, and a test can supply them in four lines.
 *
 * ## There is deliberately no per-frame AI pass yet
 *
 * Path queries are PULL-based: a controller asks during the control pass, which already runs before
 * the node loop. A pass that ran over every agent would have nothing to do until perception exists,
 * and an empty pass that walks the controller set every frame is pure cost. It arrives with vision,
 * which genuinely must be resolved for all agents before any brain reads it.
 */

/** The shape a navmesh-bearing node presents. Structural, so this module needs no node import. */
export interface NavMeshSource {
    readonly id: string;
    readonly name: string;
    readonly mesh: CleoNavMesh | null;
    readonly isBaked: boolean;
    readonly agentRadius: number;
    routePoints(name: string): vec3[];
}

/** The shape a scene presents. Structural for the same reason. */
export interface AISceneLike {
    readonly navMeshes: Set<NavMeshSource>;
    getNodeById(id: string): unknown;
}

export class AISystem {
    private _scene: AISceneLike | null = null;

    /**
     * Bind to a scene, dropping whatever the previous one left behind.
     *
     * Clearing here rather than at the call site is what `PhysicsSystem.set scene` established, and it
     * is the reason the editor's six `setScene` call sites do not each need to remember.
     */
    public setScene(scene: AISceneLike | null): void {
        this.clear();
        this._scene = scene;
    }

    public get scene(): AISceneLike | null { return this._scene; }

    public clear(): void {
        this._scene = null;
    }

    /** Per-frame counters, for the performance HUD. */
    public get stats() { return aiStats; }

    /**
     * The navmesh a controller should use.
     *
     * A named one when it resolves and is baked; otherwise the scene's first baked mesh, so a scene
     * with exactly one navmesh needs no wiring at all. An id that names a mesh which exists but is
     * NOT baked resolves to that mesh anyway rather than silently falling back — an author who picked
     * a specific mesh and got a different one would have no way to tell.
     */
    public navMeshFor(id: string | null | undefined): NavMeshSource | null {
        const scene = this._scene;
        if (!scene) return null;

        if (id) {
            for (const candidate of scene.navMeshes) {
                if (candidate.id === id) return candidate;
            }
            // A dangling id falls through to the default. The controller warns about it once; doing it
            // here would warn once per frame per agent.
        }
        for (const candidate of scene.navMeshes) {
            if (candidate.isBaked) return candidate;
        }
        return null;
    }

    /** Whether anything in this scene can answer a path query at all. */
    public get hasNavigation(): boolean {
        const scene = this._scene;
        if (!scene) return false;
        for (const candidate of scene.navMeshes) {
            if (candidate.isBaked) return true;
        }
        return false;
    }

    /**
     * A route from `from` to `to`, or an empty array when the two are not connected.
     *
     * Timed and counted, because an agent repathing every frame and one repathing twice a second look
     * identical from the outside until somebody reads `aiStats.pathQueries`.
     */
    public findPath(source: NavMeshSource | null, from: vec3, to: vec3, out: vec3[] = []): vec3[] {
        out.length = 0;
        const mesh = source?.mesh;
        if (!mesh) return out;

        const start = performance.now();
        mesh.findPath(from, to, out);
        aiStats.pathMs += performance.now() - start;
        aiStats.pathQueries++;
        if (out.length > 0) {
            aiStats.pathsFound++;
            aiStats.waypoints += out.length;
        }
        return out;
    }
}
