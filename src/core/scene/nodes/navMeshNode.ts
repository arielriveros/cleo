import { v4 as uuidv4 } from 'uuid';
import { vec3 } from "gl-matrix";
import { Logger } from "../../logger";
import { Node } from "./node";
import { NAV_BAKE_DEFAULTS, navBakeSettings } from "../../ai/navBake";
import type { NavBakeSettings } from "../../ai/navBake";
import {
    EMPTY_NAV_MESH_DATA, buildNavMesh, isNavigableUp, parseNavMeshData, serializeNavMeshData,
} from "../../ai/navMesh";
import type { CleoNavMesh, NavMeshData, NavRoute, OffMeshLink } from "../../ai/navMesh";

/**
 * A baked navigation mesh, living in the scene.
 *
 * ## Why a node and not an asset
 *
 * A navmesh is not reusable the way a material or a model is — it is the walkable surface of *this*
 * scene's geometry, and it is meaningless anywhere else. `LandscapeNode` is the precedent: bulk baked
 * data that belongs to one scene, stored on a node, blob-encoded in the scene file. Making it a
 * library asset would buy sharing nobody wants and cost the whole `AssetKind` checklist.
 *
 * ## Why more than one is allowed
 *
 * Agent size. A corridor an ogre cannot fit down is one a child walks through, and the honest way to
 * express that is two bakes of the same geometry at two clearances, with each `ControllerNode` naming
 * the one it uses. Hence a `Set` on `Scene` rather than the singleton pattern the sky nodes use.
 *
 * ## What is stored and what is derived
 *
 * The **contours** are stored; the `CleoNavMesh` is derived and rebuilt lazily on first use. That is
 * the point of storing merged regions rather than triangles: measured, replaying stored contours costs
 * 1.8 ms where re-baking the same mesh from triangles costs 0.36 s.
 *
 * The transform is deliberately ignored — the data is baked in WORLD space, because a navmesh that
 * moved with its node would invalidate every path the moment someone nudged it in the inspector.
 */
export class NavMeshNode extends Node {
    /** Settings the stored data was baked with. Kept so a re-bake starts from what was used. */
    public bake: NavBakeSettings = navBakeSettings();

    /**
     * Clearance applied when an agent FOLLOWS a path from this mesh, in world units.
     *
     * Not applied to the stored geometry: eroding the mesh takes it apart into disconnected islands
     * (see the `navBake` header for the measurement). It is applied per path by
     * `navPath.insetCorners`, which is also what lets two agent sizes share one bake.
     */
    public agentRadius: number = 0.4;

    /** Named patrol routes, in world space. Plain points, so a duplicate needs no id remapping. */
    public routes: NavRoute[] = [];

    /**
     * Off-mesh connections — a jump, a ladder, a teleport.
     *
     * Stored here, but NOT yet traversable: Yuka's `findPath` string-pulls through the portal edge each
     * consecutive pair of regions shares, and a synthetic link has none, so injecting a graph edge
     * makes the funnel throw rather than route. Traversing one means searching the graph directly and
     * stitching a path per island. Authored now, honoured when that lands.
     */
    public links: OffMeshLink[] = [];

    private _data: NavMeshData = EMPTY_NAV_MESH_DATA;
    private _mesh: CleoNavMesh | null = null;
    private _built: boolean = false;
    private _warnedGravity: boolean = false;

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'navMesh', id);
    }

    /** The baked region contours. Empty until something bakes into this node. */
    public get data(): NavMeshData { return this._data; }

    /** Replace the baked data. Drops the built mesh so the next query rebuilds. */
    public setData(data: NavMeshData): this {
        this._data = data;
        this._mesh = null;
        this._built = false;
        this._warnedGravity = false;
        return this;
    }

    public get isBaked(): boolean { return this._data.counts.length > 0; }

    /**
     * The usable navmesh, built on first access, or null when this node has nothing baked into it.
     *
     * Lazy rather than built at parse time for two reasons: a scene may hold a navmesh nothing ever
     * queries, and at parse time the physics world does not exist yet — which is what the gravity check
     * below needs.
     */
    public get mesh(): CleoNavMesh | null {
        if (this._built) return this._mesh;
        this._built = true;
        if (!this.isBaked) return (this._mesh = null);

        // Checked HERE and not only at bake time: a project can be authored under normal gravity,
        // baked, and then have its gravity changed — and at that point there is no bake left to
        // refuse. `physics` is genuinely undefined on a template or preview scene, which is not a
        // disagreement, so `isNavigableUp` passes a missing one.
        const up = this._scene?.physics?.up;
        if (!isNavigableUp(up)) {
            if (!this._warnedGravity) {
                this._warnedGravity = true;
                Logger.warn(
                    `Navmesh '${this._name}' is disabled: navigation is planar in XZ with +Y up, and ` +
                    `this scene's gravity points elsewhere. Nothing will path until gravity is ` +
                    `restored or the mesh is rebaked in a world that agrees.`, 'Scene');
            }
            return (this._mesh = null);
        }

        // merge: false — the stored contours are ALREADY merged regions. Re-merging would be both
        // slower and lossy.
        this._mesh = buildNavMesh(this._data, { merge: false });
        if (this._mesh) this._mesh.setLinks(this.links);
        else Logger.warn(`Navmesh '${this._name}' has baked data that could not be rebuilt.`, 'Scene');
        return this._mesh;
    }

    /** A named route, or null. */
    public route(name: string): NavRoute | null {
        return this.routes.find(r => r.name === name) ?? null;
    }

    /** A route's points as gl-matrix vectors, ready for `setNavPath`. Empty when there is no such route. */
    public routePoints(name: string): vec3[] {
        const route = this.route(name);
        if (!route) return [];
        return route.points.map(p => vec3.fromValues(p[0], p[1], p[2]));
    }

    // ----- serialization ---------------------------------------------------------------------------

    protected _serializePayload(): any {
        const data = serializeNavMeshData(this._data);
        return {
            bake: { ...this.bake },
            agentRadius: this.agentRadius,
            // Written only when there is something to write, so an unbaked node adds nothing to the
            // scene file beyond its settings.
            ...(data ? { navMesh: data } : {}),
            ...(this.routes.length > 0 ? { routes: this.routes } : {}),
            ...(this.links.length > 0 ? { links: this.links } : {}),
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new NavMeshNode(json.name, json.id);
        node.bake = navBakeSettings(json.bake);
        node.agentRadius = typeof json.agentRadius === 'number' && isFinite(json.agentRadius)
            ? Math.max(0, json.agentRadius) : node.agentRadius;
        node.setData(parseNavMeshData(json.navMesh));
        node.routes = parseRoutes(json.routes);
        node.links = parseLinks(json.links);

        // _commonParse adds the node to its parent — do not addChild again.
        Node.finishParse(node, parent, json);
    }
}

// ---------------------------------------------------------------------------------------------------
// Tolerant readers. Same rule as every other authored block: an unreadable entry is dropped and its
// siblings keep their order, rather than the whole scene failing to open.
// ---------------------------------------------------------------------------------------------------

function point(raw: unknown): [number, number, number] | null {
    if (!Array.isArray(raw) || raw.length < 3) return null;
    const [x, y, z] = raw;
    if (![x, y, z].every(n => typeof n === 'number' && isFinite(n))) return null;
    return [x, y, z];
}

export function parseRoutes(raw: unknown): NavRoute[] {
    if (!Array.isArray(raw)) return [];
    const out: NavRoute[] = [];
    const names = new Set<string>();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const r = entry as Record<string, unknown>;
        const name = typeof r.name === 'string' ? r.name.trim() : '';
        // A nameless route cannot be referenced, and a duplicate name would shadow the first.
        if (!name || names.has(name)) continue;
        const points: [number, number, number][] = [];
        for (const p of (Array.isArray(r.points) ? r.points : [])) {
            const parsed = point(p);
            if (parsed) points.push(parsed);
        }
        if (points.length === 0) continue;
        names.add(name);
        out.push({ name, points, loop: r.loop === true });
    }
    return out;
}

export function parseLinks(raw: unknown): OffMeshLink[] {
    if (!Array.isArray(raw)) return [];
    const out: OffMeshLink[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const l = entry as Record<string, unknown>;
        const from = point(l.from);
        const to = point(l.to);
        if (!from || !to) continue;
        out.push({
            name: typeof l.name === 'string' ? l.name : '',
            from,
            to,
            cost: typeof l.cost === 'number' && isFinite(l.cost) ? Math.max(0, l.cost) : 1,
            // Absent means true, so a link written before the flag existed stays two-way.
            bidirectional: l.bidirectional !== false,
        });
    }
    return out;
}

/** Whether a navmesh node carries nothing an author set — used to keep default nodes out of diffs. */
export function isDefaultNavMeshSettings(settings: unknown): boolean {
    const parsed = navBakeSettings(settings as Partial<NavBakeSettings>);
    return (Object.keys(NAV_BAKE_DEFAULTS) as (keyof NavBakeSettings)[])
        .every(key => parsed[key] === NAV_BAKE_DEFAULTS[key]);
}
