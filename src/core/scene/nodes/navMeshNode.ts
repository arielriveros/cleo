import { v4 as uuidv4 } from 'uuid';
import { mat4, vec3 } from "gl-matrix";
import { Logger } from "../../logger";
import { Node } from "./node";
import { NAV_BAKE_DEFAULTS, navBakeSettings } from "../../../ai/navBake";
import type { NavBakeSettings } from "../../../ai/navBake";
import {
    EMPTY_NAV_MESH_DATA, buildNavMesh, isNavigableUp, parseNavMeshData, serializeNavMeshData,
} from "../../../ai/navMesh";
import type { CleoNavMesh, NavMeshData, NavRoute, OffMeshLink } from "../../../ai/navMesh";

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
 * ## What the transform does, and what it deliberately does not
 *
 * The transform picks the BOUNDS: `size` is an oriented box, and only surfaces inside it are baked.
 * That is the whole reason to place one of these rather than leave it at the origin — "navigate this
 * room" is a sentence a whole-scene bake cannot say.
 *
 * What the transform does NOT do is move the data. The contours are still stored in WORLD space, so
 * nudging the node in the inspector cannot invalidate a path that already exists; it makes the stored
 * bake STALE, which is a different and much more recoverable problem. `bakedVolume` records the box
 * the data was baked from precisely so the editor can say so out loud instead of leaving an author to
 * wonder why a room they just enclosed has no navmesh in it.
 *
 * `size` of `[0, 0, 0]` means unbounded — the whole scene, which is what every navmesh authored
 * before volumes existed keeps doing.
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

    /**
     * The bake volume: an oriented box, full extents in world units at scale 1, centred on the node.
     * `[0, 0, 0]` means unbounded. Mirrors `LightProbeNode`'s influence volume exactly, down to the
     * unit-cube containment convention, so the two read as one idea rather than two.
     */
    private _size: [number, number, number] = [0, 0, 0];

    /**
     * World AABB of the volume at the moment the stored data was baked, or null when never baked.
     *
     * The only piece of derived state that is stored, and it earns it: without it there is no way to
     * tell a bake that covers the current box from one that covers a box the author has since moved,
     * and the two look identical in the viewport.
     */
    public bakedVolume: [number, number, number, number, number, number] | null = null;

    private _data: NavMeshData = EMPTY_NAV_MESH_DATA;
    private _mesh: CleoNavMesh | null = null;
    private _built: boolean = false;
    private _warnedGravity: boolean = false;
    private _volScratch: mat4 = mat4.create();
    private _invVolScratch: mat4 = mat4.create();

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

    // ----- bake volume -----------------------------------------------------------------------------

    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        this._size = [Math.max(0, v[0]), Math.max(0, v[1]), Math.max(0, v[2])];
    }

    /** True when this node bakes a finite box; false = the whole scene. */
    public get bounded(): boolean {
        return this._size[0] > 0 && this._size[1] > 0 && this._size[2] > 0;
    }

    /**
     * world -> volume unit cube, so containment is `|xyz| <= 0.5` and the six clip planes are +-0.5.
     * Null when unbounded, which is the value `clipSoupToVolume` reads as "keep everything".
     */
    public get invVolumeMatrix(): mat4 | null {
        if (!this.bounded) return null;
        const volume = mat4.scale(this._volScratch, this.worldTransform, this._size);
        return mat4.invert(this._invVolScratch, volume) ? this._invVolScratch : null;
    }

    /** The volume's world AABB, in the shape `bakedVolume` stores. Null when unbounded. */
    public volumeBounds(): [number, number, number, number, number, number] | null {
        if (!this.bounded) return null;
        const { min, max } = this.getBoundingBox();
        return [min[0], min[1], min[2], max[0], max[1], max[2]];
    }

    /**
     * Whether the volume has moved or resized since the stored data was baked.
     *
     * Compared with a tolerance rather than exactly: the AABB is rebuilt from a matrix every time it
     * is asked for, and float drift on an untouched node would otherwise report a permanent warning.
     */
    public get bakeIsStale(): boolean {
        if (!this.isBaked) return false;
        const current = this.volumeBounds();
        if (!current || !this.bakedVolume) return current !== this.bakedVolume;
        return current.some((v, i) => Math.abs(v - this.bakedVolume![i]) > 1e-3);
    }

    /**
     * World AABB of the oriented bake box, so framing and the bounding-box overlay both find the
     * volume rather than a point at the origin. Unbounded falls back to the base implementation.
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        if (!this.bounded) return super.getBoundingBox();
        const world = mat4.scale(this._volScratch, this.worldTransform, this._size);
        const min = vec3.fromValues(Infinity, Infinity, Infinity);
        const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
        const corner = vec3.create();
        for (let i = 0; i < 8; i++) {
            vec3.set(corner, (i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5);
            vec3.transformMat4(corner, corner, world);
            vec3.min(min, min, corner);
            vec3.max(max, max, corner);
        }
        return { min, max };
    }

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
            // Unbounded writes nothing, so a node left at the whole-scene default is byte-identical
            // to one authored before volumes existed.
            ...(this.bounded ? { size: [...this._size] } : {}),
            ...(this.bakedVolume ? { bakedVolume: [...this.bakedVolume] } : {}),
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
        node.size = parseSize(json.size);
        node.bakedVolume = parseBakedVolume(json.bakedVolume);
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

/** Absent or unreadable means unbounded, which is what every pre-volume scene wants. */
export function parseSize(raw: unknown): [number, number, number] {
    const p = point(raw);
    return p ? [Math.max(0, p[0]), Math.max(0, p[1]), Math.max(0, p[2])] : [0, 0, 0];
}

/** A six-number world AABB, or null. A malformed one reads as "never baked", not as a stale bake. */
export function parseBakedVolume(raw: unknown): [number, number, number, number, number, number] | null {
    if (!Array.isArray(raw) || raw.length < 6) return null;
    const out = raw.slice(0, 6);
    if (!out.every(n => typeof n === 'number' && isFinite(n))) return null;
    return out as [number, number, number, number, number, number];
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
