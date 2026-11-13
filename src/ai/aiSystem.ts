import { vec3 } from "gl-matrix";
import { aiStats } from "./aiStats";
import type { CleoNavMesh } from "./navMesh";
import type { NavGraph2D } from "./navGraph2D";
import type { NavPath } from "./navPath";

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
    /** '2D' for a 2D scene's navigation (a platform graph or an air grid), which answers through graph2D. */
    readonly space?: '3D' | '2D';
    readonly graph2D?: NavGraph2D | null;
}

/** What a controller looks for when it names no navmesh: a 2D graph for its kind of mover, or a 3D mesh. */
export interface NavPreference {
    space: '3D' | '2D';
    movement?: 'walk' | 'fly';
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
     * Build every baked navmesh of the bound scene now, rather than on the frame an agent first asks.
     *
     * `NavMeshNode.mesh` builds lazily, and for a large terrain bake that build is the single most
     * expensive thing an agent ever does: the Valley's 45k regions took the better part of a second, on
     * the frame the first enemy noticed the player and started its chase. `Scene.start` calls this on a
     * running scene, where a load is already expected. Returns the milliseconds it spent, which is ~0 when
     * the meshes were already built or shared from an earlier scene with the same bake.
     */
    public prewarm(): number {
        const scene = this._scene;
        if (!scene) return 0;
        const start = performance.now();
        for (const source of scene.navMeshes) {
            if (!source.isBaked) continue;
            if (source.space === '2D') void source.graph2D;
            else void source.mesh;
        }
        return performance.now() - start;
    }

    /**
     * The navmesh a controller should use.
     *
     * A named one when it resolves and is baked; otherwise the scene's first baked mesh, so a scene
     * with exactly one navmesh needs no wiring at all. An id that names a mesh which exists but is
     * NOT baked resolves to that mesh anyway rather than silently falling back — an author who picked
     * a specific mesh and got a different one would have no way to tell.
     */
    public navMeshFor(id: string | null | undefined, prefer?: NavPreference): NavMeshSource | null {
        const scene = this._scene;
        if (!scene) return null;

        if (id) {
            for (const candidate of scene.navMeshes) {
                if (candidate.id === id) return candidate;
            }
            // A dangling id falls through to the default. The controller warns about it once; doing it
            // here would warn once per frame per agent.
        }
        // The default is the first baked source of the kind the asker moves through: a 2D walker gets the
        // first walk graph, a flier the first air grid, and a 3D agent never a 2D node.
        const space = prefer?.space ?? '3D';
        for (const candidate of scene.navMeshes) {
            if (!candidate.isBaked || (candidate.space ?? '3D') !== space) continue;
            if (space === '2D' && prefer?.movement && candidate.graph2D?.movement !== prefer.movement) continue;
            return candidate;
        }
        return null;
    }

    /**
     * A 2D route from `from` to `to` (feet for a walker, middles for a flier) into `out`, with the action of
     * each leg. False, and `out` empty, when the source has no graph or the two are not connected.
     */
    public findPath2D(source: NavMeshSource | null, from: ArrayLike<number>, to: ArrayLike<number>, out: NavPath): boolean {
        const graph = source?.graph2D;
        if (!graph) { out.points.length = 0; out.actions.length = 0; out.throttles.length = 0; out.index = 0; return false; }
        const start = performance.now();
        const found = graph.findPath(from, to, out);
        aiStats.pathMs += performance.now() - start;
        aiStats.pathQueries++;
        if (found) {
            aiStats.pathsFound++;
            aiStats.waypoints += out.points.length;
        }
        return found;
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
