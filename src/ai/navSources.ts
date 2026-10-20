/**
 * Turning a level into the triangle soup `navBake` wants.
 *
 * A LEAF: primitives and matrices in, flat typed arrays out. Nothing here knows what a `Node` is, so
 * the editor can feed it collider descriptions and a published game could feed it live bodies without
 * either of them teaching this module about the other.
 *
 * ## Why colliders and not render meshes
 *
 * The obvious source is every `ModelNode`'s geometry. It is the wrong one, and each reason is a bug
 * you would otherwise ship:
 *
 *   - **Invisible colliders vanish.** A box collider blocking a corridor has no mesh, so a
 *     geometry-derived navmesh routes agents straight through it. This is the big one.
 *   - **LOD levels double-count.** A `LodGroupNode` keeps every level as a child, so a naive walk
 *     bakes three co-located copies of the same floor.
 *   - **Skinned meshes contribute a bind pose**, which is nowhere in particular.
 *   - **Wireframe helper geometry reads as garbage.** `Geometry.Cube(w, h, d, true)` and `ConvexHull`
 *     emit GL_LINES index PAIRS; interpreting those as triangles produces nonsense.
 *   - **Foliage would swamp it.** A layer is up to 200,000 instances.
 *
 * A collider set has none of those problems, and it is by definition the thing the character already
 * collides with — so the navmesh agrees with the physics rather than approximating it.
 *
 * ## Spheres and capsules are surfaces of nothing, but they are still obstacles
 *
 * Neither offers a walkable surface: the slope filter would keep only a degenerate patch at the very
 * top, which is not somewhere an agent can stand, so they are never tessellated. They DO occupy space,
 * though, and `carveSoup` subtracts them -- with boxes, cylinders and hulls -- from the floor around
 * them. A `plane` is neither: it is an infinite half-space in cannon with no honest finite
 * tessellation, so the caller supplies an extent if it wants one, and it never carves.
 */

import { mat4, quat, vec3 } from "gl-matrix";
import type { TriangleSoup } from "./navBake";
import type { FoliageCollision } from "../graphics/material";
import { foliageColliderPose } from "../terrain/foliageColliderPose";

/** A collider shape, stripped to what tessellation needs. */
export type NavPrimitive =
    | { kind: 'box'; size: readonly [number, number, number] }
    | { kind: 'cylinder'; radius: number; height: number; segments?: number }
    | { kind: 'convex'; vertices: readonly (readonly number[])[]; faces: readonly (readonly number[])[] }
    /** Cannon's plane is an infinite half-space; `extent` is how much of it to actually emit. */
    | { kind: 'plane'; extent: number }
    /** Obstacle-only kinds: never tessellated (no surface to stand on), but `navObstacleFor` carves them. */
    | { kind: 'sphere'; radius: number }
    /** Along local Y. `height` is tip to tip, as on the collider. */
    | { kind: 'capsule'; radius: number; height: number };

/** One collider, placed. `transform` is the full local-to-world matrix, offsets already folded in. */
export interface NavSource {
    primitive: NavPrimitive;
    transform: mat4;
}

/** Growable triangle accumulator, so a whole level can be gathered without intermediate arrays. */
export class SoupBuilder {
    private readonly _positions: number[] = [];

    public get triangleCount(): number { return this._positions.length / 9; }

    /** Append a triangle already in world space. */
    public triangle(a: vec3, b: vec3, c: vec3): void {
        this._positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }

    /**
     * Append a convex polygon as a fan, transformed by `m`.
     *
     * A fan is valid only because every face this module emits is convex — a box face, a cylinder cap,
     * a hull face. A concave polygon would need real triangulation.
     */
    public polygon(points: readonly (readonly number[])[], m: mat4): void {
        if (points.length < 3) return;
        const a = vec3.create(), b = vec3.create(), c = vec3.create();
        vec3.transformMat4(a, vec3.set(a, points[0][0], points[0][1], points[0][2]), m);
        for (let i = 1; i + 1 < points.length; i++) {
            vec3.transformMat4(b, vec3.set(b, points[i][0], points[i][1], points[i][2]), m);
            vec3.transformMat4(c, vec3.set(c, points[i + 1][0], points[i + 1][1], points[i + 1][2]), m);
            this.triangle(a, b, c);
        }
    }

    /** The finished soup. Non-indexed: consecutive triples are the triangles. */
    public build(): TriangleSoup {
        return { positions: new Float32Array(this._positions), indices: new Uint32Array(0) };
    }
}

// ---------------------------------------------------------------------------------------------------
// Primitives
//
// Every face is wound counter-clockwise seen from OUTSIDE, which is what makes the outward normal come
// out of `(b - a) x (c - a)`. The bake's slope filter reads that sign and does not take an absolute
// value -- get a winding backwards here and that face becomes a ceiling, silently.
// ---------------------------------------------------------------------------------------------------

/** The eight corners of a box centred on the origin. */
function boxCorners(size: readonly [number, number, number]): number[][] {
    const x = size[0] / 2, y = size[1] / 2, z = size[2] / 2;
    return [
        [-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z],
        [-x, y, -z], [x, y, -z], [x, y, z], [-x, y, z],
    ];
}

// Each face as indices into boxCorners, wound CCW from outside.
const BOX_FACES: number[][] = [
    [4, 7, 6, 5], // +Y, the top -- the only one a slope filter will keep
    [0, 1, 2, 3], // -Y
    [3, 2, 6, 7], // +Z
    [1, 0, 4, 5], // -Z
    [2, 1, 5, 6], // +X
    [0, 3, 7, 4], // -X
];

function tessellateBox(out: SoupBuilder, size: readonly [number, number, number], m: mat4): void {
    const corners = boxCorners(size);
    for (const face of BOX_FACES) out.polygon(face.map(i => corners[i]), m);
}

function tessellateCylinder(
    out: SoupBuilder, radius: number, height: number, segments: number, m: mat4,
): void {
    const n = Math.max(3, Math.min(64, Math.round(segments)));
    const half = height / 2;
    const top: number[][] = [];
    const bottom: number[][] = [];
    for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        top.push([x, half, z]);
        bottom.push([x, -half, z]);
    }
    // The cap winding: `top` walks counter-clockwise in XZ, which seen from +Y is CLOCKWISE, so it is
    // reversed to face up. Getting this backwards makes a pillar's top read as a ceiling.
    out.polygon([...top].reverse(), m);
    out.polygon(bottom, m);

    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        out.polygon([bottom[i], bottom[j], top[j], top[i]], m);
    }
}

function tessellateConvex(
    out: SoupBuilder,
    vertices: readonly (readonly number[])[],
    faces: readonly (readonly number[])[],
    m: mat4,
): void {
    for (const face of faces) {
        if (face.length < 3) continue;
        const points: number[][] = [];
        let valid = true;
        for (const index of face) {
            const v = vertices[index];
            // A face indexing a vertex that is not there means a truncated hull. Drop the face rather
            // than emit a triangle at the origin, which would be a spike through the whole level.
            if (!v || v.length < 3) { valid = false; break; }
            points.push([v[0], v[1], v[2]]);
        }
        if (valid) out.polygon(points, m);
    }
}

/** A finite patch of an infinite plane, facing +Y in its own space (cannon's plane faces +Z). */
function tessellatePlane(out: SoupBuilder, extent: number, m: mat4): void {
    const e = Math.max(0, extent);
    if (e <= 0) return;
    out.polygon([[-e, 0, -e], [-e, 0, e], [e, 0, e], [e, 0, -e]], m);
}

/** Tessellate one placed collider into `out`. Unsupported kinds contribute nothing. */
export function tessellateSource(out: SoupBuilder, source: NavSource): void {
    const p = source.primitive;
    switch (p.kind) {
        case 'box': tessellateBox(out, p.size, source.transform); break;
        case 'cylinder':
            tessellateCylinder(out, p.radius, p.height, p.segments ?? 12, source.transform);
            break;
        case 'convex': tessellateConvex(out, p.vertices, p.faces, source.transform); break;
        case 'plane': tessellatePlane(out, p.extent, source.transform); break;
    }
}

/** Gather a whole level's colliders into one soup. */
export function tessellateSources(sources: Iterable<NavSource>): TriangleSoup {
    const builder = new SoupBuilder();
    for (const source of sources) tessellateSource(builder, source);
    return builder.build();
}

// ---------------------------------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------------------------------

export interface HeightfieldSource {
    /** Row-major heights, `resolution * resolution` of them. */
    heights: ArrayLike<number>;
    /** Samples per side. */
    resolution: number;
    /** World units between samples. */
    elementSize: number;
    /** World position of the terrain's CENTRE. */
    origin: readonly [number, number, number];
}

/**
 * Triangulate a terrain heightfield, optionally at reduced resolution.
 *
 * Sampled directly rather than read off the generated chunk `ModelNode`s, which is the trap: those are
 * named `__terrain_chunk__*` and their geometry is LOD-mutated in place, so a walk of the scene graph
 * picks up whatever level happened to be resident.
 *
 * `step` decimates. A 129-sample terrain is 32,768 triangles at full resolution, which is more detail
 * than an XZ-planar navmesh can use — the debug mesh downsamples for the same reason.
 */
export function heightfieldSoup(source: HeightfieldSource, step: number = 1): TriangleSoup {
    const { heights, resolution, elementSize, origin } = source;
    const stride = Math.max(1, Math.round(step));
    if (resolution < 2 || elementSize <= 0) return { positions: new Float32Array(0), indices: new Uint32Array(0) };

    const half = (resolution - 1) * elementSize / 2;
    const at = (row: number, col: number, out: vec3): vec3 => {
        const r = Math.min(row, resolution - 1);
        const c = Math.min(col, resolution - 1);
        return vec3.set(out,
            origin[0] - half + c * elementSize,
            origin[1] + (heights[r * resolution + c] ?? 0),
            origin[2] - half + r * elementSize);
    };

    const builder = new SoupBuilder();
    const a = vec3.create(), b = vec3.create(), c = vec3.create(), d = vec3.create();
    for (let row = 0; row + stride <= resolution - 1; row += stride) {
        for (let col = 0; col + stride <= resolution - 1; col += stride) {
            at(row, col, a);
            at(row + stride, col, b);
            at(row + stride, col + stride, c);
            at(row, col + stride, d);
            // Wound so `(b - a) x (c - a)` points UP. With +col along +X and +row along +Z, the corner
            // order that works is a -> c -> d and a -> b -> c; the mirror of each reads as a ceiling
            // and the slope filter drops the entire terrain with nothing logged.
            builder.triangle(a, c, d);
            builder.triangle(a, b, c);
        }
    }
    return builder.build();
}

/** Concatenate several soups into one. */
export function mergeSoups(soups: readonly TriangleSoup[]): TriangleSoup {
    let total = 0;
    for (const soup of soups) total += soup.indices.length > 0 ? soup.indices.length * 3 : soup.positions.length;
    const positions = new Float32Array(total);
    let offset = 0;
    for (const soup of soups) {
        if (soup.indices.length > 0) {
            // Flatten to non-indexed while merging: two soups cannot share an index space, and the
            // bake welds afterwards anyway.
            for (const index of soup.indices) {
                positions[offset++] = soup.positions[index * 3];
                positions[offset++] = soup.positions[index * 3 + 1];
                positions[offset++] = soup.positions[index * 3 + 2];
            }
        } else {
            positions.set(soup.positions, offset);
            offset += soup.positions.length;
        }
    }
    return { positions: positions.subarray(0, offset), indices: new Uint32Array(0) };
}

// ---------------------------------------------------------------------------------------------------
// Bounds volumes
// ---------------------------------------------------------------------------------------------------

/**
 * Clip a world-space soup to an oriented box.
 *
 * `invMatrix` maps world space into the box's UNIT CUBE, so the six clip planes are just `+-0.5` on
 * each axis and no plane equations need deriving. `NavMeshNode.invVolumeMatrix` produces exactly this,
 * the same way `LightProbeNode` expresses its influence volume. A `null` matrix means "unbounded" and
 * returns the soup untouched, which is the path every scene authored before volumes existed takes.
 *
 * ## Why an exact clip rather than a centroid or any-vertex test
 *
 * Both cheaper tests were tried on real terrain and both look broken. A heightfield triangle at the
 * default sample step is several metres across, so an all-or-nothing decision leaves a border that
 * wanders metres either side of the box the author drew -- over-reaching into a room they excluded, or
 * biting a chunk out of the one they meant to include. Clipping makes the navmesh stop ON the box
 * face, which is what sizing a box to a room means.
 *
 * A triangle clipped by a convex box is always a convex polygon, so `SoupBuilder.polygon`'s fan is a
 * valid triangulation -- the same property every primitive in this file already relies on.
 */
export function clipSoupToVolume(soup: TriangleSoup, invMatrix: mat4 | null): TriangleSoup {
    if (!invMatrix) return soup;

    const { positions, indices } = soup;
    const count = indices.length > 0 ? indices.length : positions.length / 3;
    if (count < 3) return { positions: new Float32Array(0), indices: new Uint32Array(0) };

    // Back to world afterwards. An inverse that does not exist means a volume with a zero extent on
    // some axis, which contains nothing -- so the honest answer is an empty soup, not the whole level.
    const toWorld = mat4.invert(mat4.create(), invMatrix);
    if (!toWorld) return { positions: new Float32Array(0), indices: new Uint32Array(0) };

    const at = (i: number) => (indices.length > 0 ? indices[i] : i) * 3;
    const builder = new SoupBuilder();
    const scratch = vec3.create();

    for (let t = 0; t + 2 < count; t += 3) {
        const ia = at(t), ib = at(t + 1), ic = at(t + 2);
        if (ia + 2 >= positions.length || ib + 2 >= positions.length || ic + 2 >= positions.length) break;

        // Into unit-cube space, where clipping is six axis-aligned comparisons.
        let poly: number[][] = [];
        for (const base of [ia, ib, ic]) {
            vec3.set(scratch, positions[base], positions[base + 1], positions[base + 2]);
            vec3.transformMat4(scratch, scratch, invMatrix);
            poly.push([scratch[0], scratch[1], scratch[2]]);
        }

        for (let axis = 0; axis < 3 && poly.length >= 3; axis++) {
            poly = clipToHalfSpace(poly, axis, 1);   // keep <= +0.5
            if (poly.length < 3) break;
            poly = clipToHalfSpace(poly, axis, -1);  // keep >= -0.5
        }
        if (poly.length < 3) continue;

        builder.polygon(poly, toWorld);
    }
    return builder.build();
}

/**
 * Sutherland-Hodgman against one face of the unit cube.
 *
 * `sign` +1 keeps points with `p[axis] <= 0.5`, -1 keeps `p[axis] >= -0.5`. Expressed as a signed
 * distance so both faces share one crossing calculation; a point exactly on the plane counts as
 * inside, which is what stops a triangle that merely touches the box face from being dropped.
 */
function clipToHalfSpace(poly: readonly number[][], axis: number, sign: number): number[][] {
    const out: number[][] = [];
    const distance = (p: readonly number[]) => 0.5 - sign * p[axis];

    for (let i = 0; i < poly.length; i++) {
        const current = poly[i];
        const next = poly[(i + 1) % poly.length];
        const dc = distance(current);
        const dn = distance(next);

        if (dc >= 0) out.push([current[0], current[1], current[2]]);
        // Strictly opposite signs only: two points both ON the plane must not manufacture a crossing,
        // which would emit a duplicate vertex and, with enough of them, a zero-area sliver.
        if ((dc > 0 && dn < 0) || (dc < 0 && dn > 0)) {
            const t = dc / (dc - dn);
            out.push([
                current[0] + (next[0] - current[0]) * t,
                current[1] + (next[1] - current[1]) * t,
                current[2] + (next[2] - current[2]) * t,
            ]);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------
// Collider descriptions
// ---------------------------------------------------------------------------------------------------

/**
 * A collider as `body.shapes[]` stores it -- the editor's `ShapeDescription` and the scene JSON alike,
 * structurally, so the headless example generators share this convention with the editor.
 */
export interface NavShapeDescription {
    type: string;
    offset: readonly number[];
    rotation: readonly number[];
    width?: number;
    height?: number;
    depth?: number;
    radius?: number;
    numSegments?: number;
    vertices?: readonly (readonly number[])[];
    faces?: readonly (readonly number[])[];
}

/**
 * One collider as a placed primitive, or null for a kind with no shape here.
 *
 * `world` is the owner's position + rotation with SCALE DELIBERATELY LEFT OUT; `scale` is its world
 * scale. That is the order cannon uses (`applyShapeTransform` in the editor is the reference): a shape's
 * OFFSET is scaled by the owner and then rotated, while its DIMENSIONS take the same scale directly.
 * A matrix carrying the scale as well applies it twice -- a collider that grows quadratically.
 */
export function navSourceForShape(
    shape: NavShapeDescription, world: mat4, scale: ArrayLike<number>,
): NavSource | null {
    const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]), sz = Math.abs(scale[2]);
    const rotation = quat.fromEuler(quat.create(),
        shape.rotation[0] ?? 0, shape.rotation[1] ?? 0, shape.rotation[2] ?? 0);
    const local = mat4.fromRotationTranslation(mat4.create(), rotation, [
        (shape.offset[0] ?? 0) * sx, (shape.offset[1] ?? 0) * sy, (shape.offset[2] ?? 0) * sz,
    ]);
    const transform = mat4.multiply(mat4.create(), world, local);
    const radial = Math.max(sx, sz);

    switch (shape.type) {
        case 'box':
            return {
                primitive: { kind: 'box', size: [(shape.width ?? 1) * sx, (shape.height ?? 1) * sy, (shape.depth ?? 1) * sz] },
                transform,
            };
        case 'cylinder':
            return {
                primitive: {
                    kind: 'cylinder',
                    radius: (shape.radius ?? 0.5) * radial,
                    height: (shape.height ?? 1) * sy,
                    segments: shape.numSegments,
                },
                transform,
            };
        case 'sphere':
            return { primitive: { kind: 'sphere', radius: (shape.radius ?? 0.5) * Math.max(sx, sy, sz) }, transform };
        case 'capsule':
            return {
                primitive: { kind: 'capsule', radius: (shape.radius ?? 0.5) * radial, height: (shape.height ?? 2) * sy },
                transform,
            };
        case 'convex':
            // Hull vertices are authored in the node's local space, so the node scale belongs in the
            // matrix for this one -- there is no scalar dimension to fold it into.
            if (!shape.vertices || !shape.faces) return null;
            return {
                primitive: { kind: 'convex', vertices: shape.vertices, faces: shape.faces },
                transform: mat4.scale(transform, transform, [sx, sy, sz]),
            };
        case 'plane':
            // cannon's plane is an infinite half-space. `extent` is how much of it is worth emitting; a
            // navmesh over a genuinely infinite floor is not a thing anyone wants baked.
            return { primitive: { kind: 'plane', extent: 100 }, transform };
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------------------------------
// Obstacle carving
// ---------------------------------------------------------------------------------------------------

/**
 * A solid the navmesh must keep agents out of: the convex hull of `points`, in world space.
 *
 * Points rather than faces because carving only ever needs the hull's horizontal SLICES, and a slice
 * of a hull is the hull of its points and its edge crossings -- which every point PAIR covers (an
 * interior pair's crossing lies inside the hull and changes nothing). So no face or edge topology has
 * to be carried, and a sphere is just a cloud.
 */
export interface NavObstacle {
    /** Flat xyz. */
    points: Float32Array;
    min: [number, number, number];
    max: [number, number, number];
}

/** A sphere (or one hemisphere of it) as a point cloud, lifted so its hull contains the real sphere. */
function spherePoints(radius: number, centreY: number, hemisphere: 0 | 1 | -1, out: number[]): void {
    const long = 8;
    const lift = 1 / Math.cos(Math.PI / long);
    const r = radius * lift * lift;
    for (const lat of [-90, -45, 0, 45, 90]) {
        if (hemisphere === 1 && lat < 0) continue;
        if (hemisphere === -1 && lat > 0) continue;
        const phi = lat * Math.PI / 180;
        const y = centreY + Math.sin(phi) * r;
        if (Math.abs(lat) === 90) { out.push(0, y, 0); continue; }
        const ring = Math.cos(phi) * r;
        for (let i = 0; i < long; i++) {
            const angle = (i / long) * Math.PI * 2;
            out.push(Math.cos(angle) * ring, y, Math.sin(angle) * ring);
        }
    }
}

/** The local-space hull points of a primitive, or null for a kind that occupies nothing finite. */
function obstaclePoints(p: NavPrimitive): number[] | null {
    const out: number[] = [];
    switch (p.kind) {
        case 'box':
            for (const corner of boxCorners(p.size)) out.push(corner[0], corner[1], corner[2]);
            return out;
        case 'cylinder': {
            const n = Math.max(3, Math.min(32, Math.round(p.segments ?? 12)));
            // Circumscribed, so the polygon contains the round collider rather than cutting its sides.
            const r = p.radius / Math.cos(Math.PI / n);
            for (let i = 0; i < n; i++) {
                const angle = (i / n) * Math.PI * 2;
                const x = Math.cos(angle) * r, z = Math.sin(angle) * r;
                out.push(x, p.height / 2, z, x, -p.height / 2, z);
            }
            return out;
        }
        case 'convex':
            for (const v of p.vertices) if (v && v.length >= 3) out.push(v[0], v[1], v[2]);
            return out.length >= 9 ? out : null;
        case 'sphere':
            spherePoints(p.radius, 0, 0, out);
            return out;
        case 'capsule': {
            const half = Math.max(0, p.height / 2 - p.radius);
            spherePoints(p.radius, half, 1, out);
            spherePoints(p.radius, -half, -1, out);
            return out;
        }
        case 'plane':
            return null;
    }
}

/** A placed collider as an obstacle, or null when it occupies nothing finite (a plane). */
export function navObstacleFor(source: NavSource): NavObstacle | null {
    const local = obstaclePoints(source.primitive);
    if (!local) return null;
    const points = new Float32Array(local.length);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const v = vec3.create();
    for (let i = 0; i < local.length; i += 3) {
        vec3.transformMat4(v, vec3.set(v, local[i], local[i + 1], local[i + 2]), source.transform);
        for (let k = 0; k < 3; k++) {
            points[i + k] = v[k];
            if (v[k] < min[k]) min[k] = v[k];
            if (v[k] > max[k]) max[k] = v[k];
        }
    }
    if (!Number.isFinite(min[0] + min[1] + min[2] + max[0] + max[1] + max[2])) return null;
    return { points, min, max };
}

/**
 * Every collidable foliage instance as an obstacle: a forest's trunks, posed exactly as
 * `foliageColliderPose` poses their physics bodies. `instances` is the layer's stride-5 record,
 * `[x, y, z, yaw (radians), scale]` per instance, in world space.
 */
export function foliageNavObstacles(
    instances: ArrayLike<number>, collision: FoliageCollision, count: number = instances.length / 5,
): NavObstacle[] {
    const out: NavObstacle[] = [];
    const rotation = quat.create();
    for (let i = 0; i < count; i++) {
        const b = i * 5;
        if (b + 4 >= instances.length) break;
        const pose = foliageColliderPose(collision, instances[b + 4]);
        const primitive: NavPrimitive = pose.shape === 'sphere'
            ? { kind: 'sphere', radius: pose.size[0] / 2 }
            : pose.shape === 'box'
                ? { kind: 'box', size: pose.size }
                : { kind: 'cylinder', radius: pose.size[0] / 2, height: pose.size[1], segments: 8 };
        // Only a box turns with its instance. A round trunk is the same at any yaw, and left unturned its
        // octagon lines up with the agent pad's, so their sum is another octagon rather than a 16-gon --
        // half the cut edges, across hundreds of trees.
        quat.setAxisAngle(rotation, [0, 1, 0], pose.shape === 'box' ? instances[b + 3] : 0);
        const transform = mat4.fromRotationTranslation(mat4.create(), rotation,
            [instances[b], instances[b + 1] + pose.offsetY, instances[b + 2]]);
        const obstacle = navObstacleFor({ primitive, transform });
        if (obstacle) out.push(obstacle);
    }
    return out;
}

export interface NavCarveOptions {
    /** Clearance kept from every obstacle, in world units. */
    agentRadius: number;
    /** Headroom: an obstacle wholly higher than this above the floor (a lintel) does not carve it. */
    agentHeight: number;
    /** An obstacle rising less than this above the floor is stepped over rather than carved around. */
    stepHeight: number;
    /** Degrees. Steeper triangles pass through untouched -- the slope filter drops them anyway. */
    maxSlope: number;
}

/** Directions the agent's footprint disc is approximated with. */
const PAD_DIRECTIONS = 8;
const IDENTITY = mat4.create();

/**
 * Remove the floor agents cannot stand on because something solid is in the way.
 *
 * ## The test is per POINT of floor, measured from the floor's plane
 *
 * A floor point is obstructed when some obstacle point lies within `agentRadius` of it horizontally
 * and between `stepHeight` and `agentHeight` above it. Above its PLANE, not above one floor height,
 * because the cheap version -- "the obstacle's top is more than a step above the triangle" -- is wrong
 * on exactly the shapes levels are made of:
 *
 *   - **A ramp carves itself.** Its top is metres above its own lowest vertex.
 *   - **A ramp's foot cuts the floor off from it.** The floor is carved to the radius all round the
 *     ramp, including where the ramp is still flush with it.
 *   - **A ledge eats the top of the ramp that climbs it.**
 *
 * So the obstacle is SHEARED until the triangle's plane is height 0 -- a linear map, so the hull stays
 * a hull -- then sliced between `stepHeight` and `agentHeight`, projected to XZ and padded by the
 * radius. Every case above falls out of it: a surface's own solid lies below its plane and slices to
 * nothing, a ramp is an obstacle only where it has risen a step above the floor, and a lintel overhead
 * slices to nothing too.
 *
 * ## Why this is safe where insetting regions was not
 *
 * navBake.ts records why pulling regions back from walls was abandoned: a half-space clip moves shared
 * edges along with walled ones and tears the mesh into islands. This is a different operation -- an
 * obstacle's whole padded footprint is subtracted from every triangle it touches, so both sides of a
 * shared edge lose exactly the same area -- and it runs BEFORE welding, so the cut edges are welded
 * and T-junction-split like any others.
 *
 * Triangle minus a convex polygon is the union over its edges i of `T ∩ outside(e_i) ∩ inside(e_<i)`,
 * each piece a convex clip of the triangle, so `SoupBuilder.polygon`'s fan stays a valid triangulation.
 */
export function carveSoup(
    soup: TriangleSoup, obstacles: readonly NavObstacle[], options: NavCarveOptions,
): TriangleSoup {
    const { positions, indices } = soup;
    const count = indices.length > 0 ? indices.length : positions.length / 3;
    if (obstacles.length === 0 || count < 3) return soup;

    const radius = Math.max(0, options.agentRadius);
    const height = Math.max(0, options.agentHeight);
    const step = Math.min(height, Math.max(0, options.stepHeight));
    const slope = Math.min(89, Math.max(0, options.maxSlope)) * Math.PI / 180;
    const minNy = Math.cos(slope);
    // How far a walkable plane can climb across the padding, which loosens the cheap vertical reject.
    const rise = radius * Math.min(60, Math.tan(slope));

    // A uniform grid over the obstacles' padded footprints. A forest is thousands of trunks; without it
    // every terrain triangle would test every one of them.
    const CELL = 8;
    const grid = new Map<number, number[]>();
    const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);
    for (let o = 0; o < obstacles.length; o++) {
        const ob = obstacles[o];
        const x0 = Math.floor((ob.min[0] - radius) / CELL), x1 = Math.floor((ob.max[0] + radius) / CELL);
        const z0 = Math.floor((ob.min[2] - radius) / CELL), z1 = Math.floor((ob.max[2] + radius) / CELL);
        if (x1 - x0 > 4096 || z1 - z0 > 4096) continue;
        for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
            const k = key(ix, iz);
            const list = grid.get(k);
            if (list) list.push(o); else grid.set(k, [o]);
        }
    }
    const stamp = new Int32Array(obstacles.length).fill(-1);

    const at = (i: number) => (indices.length > 0 ? indices[i] : i) * 3;
    const builder = new SoupBuilder();
    const a = vec3.create(), b = vec3.create(), c = vec3.create();

    for (let t = 0; t + 2 < count; t += 3) {
        const ia = at(t), ib = at(t + 1), ic = at(t + 2);
        if (ia + 2 >= positions.length || ib + 2 >= positions.length || ic + 2 >= positions.length) break;
        vec3.set(a, positions[ia], positions[ia + 1], positions[ia + 2]);
        vec3.set(b, positions[ib], positions[ib + 1], positions[ib + 2]);
        vec3.set(c, positions[ic], positions[ic + 1], positions[ic + 2]);

        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        // Walls, ceilings and slivers are the slope filter's business; carving them is wasted work.
        if (len < 1e-12 || ny / len < minNy) { builder.triangle(a, b, c); continue; }

        const minX = Math.min(a[0], b[0], c[0]), maxX = Math.max(a[0], b[0], c[0]);
        const minY = Math.min(a[1], b[1], c[1]), maxY = Math.max(a[1], b[1], c[1]);
        const minZ = Math.min(a[2], b[2], c[2]), maxZ = Math.max(a[2], b[2], c[2]);

        let pieces: number[][][] | null = null;
        const x0 = Math.floor((minX - radius) / CELL), x1 = Math.floor((maxX + radius) / CELL);
        const z0 = Math.floor((minZ - radius) / CELL), z1 = Math.floor((maxZ + radius) / CELL);
        scan: for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
            const list = grid.get(key(ix, iz));
            if (!list) continue;
            for (const o of list) {
                if (stamp[o] === t) continue;
                stamp[o] = t;
                const ob = obstacles[o];
                if (ob.max[0] + radius < minX || ob.min[0] - radius > maxX) continue;
                if (ob.max[2] + radius < minZ || ob.min[2] - radius > maxZ) continue;
                if (ob.max[1] < minY - rise + step || ob.min[1] > maxY + rise + height) continue;

                const footprint = obstructedFootprint(ob, a, nx, ny, nz, step, height, radius);
                if (!footprint) continue;
                pieces = subtractFootprint(pieces ?? [[
                    [a[0], a[1], a[2]], [b[0], b[1], b[2]], [c[0], c[1], c[2]],
                ]], footprint);
                if (pieces.length === 0) break scan;
            }
        }

        if (!pieces) builder.triangle(a, b, c);
        else for (const piece of pieces) builder.polygon(piece, IDENTITY);
    }
    return builder.build();
}

/**
 * The XZ region of a floor plane an obstacle makes unstandable: the obstacle sheared so the plane
 * through `a` with normal `n` is height 0, sliced to `[low, high]`, projected and padded by `radius`.
 * A CCW convex polygon as flat `[x, z, ...]`, or null when the slice is empty.
 */
function obstructedFootprint(
    ob: NavObstacle, a: vec3, nx: number, ny: number, nz: number,
    low: number, high: number, radius: number,
): number[] | null {
    const pts = ob.points;
    const n = pts.length / 3;
    const rel = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
        rel[i] = y - (a[1] - (nx * (x - a[0]) + nz * (z - a[2])) / ny);
    }

    const slice: number[] = [];
    for (let i = 0; i < n; i++) {
        if (rel[i] >= low && rel[i] <= high) slice.push(pts[i * 3], pts[i * 3 + 2]);
        for (let j = i + 1; j < n; j++) {
            for (let level = low; ; level = high) {
                const di = rel[i] - level, dj = rel[j] - level;
                if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) {
                    const s = di / (di - dj);
                    slice.push(
                        pts[i * 3] + (pts[j * 3] - pts[i * 3]) * s,
                        pts[i * 3 + 2] + (pts[j * 3 + 2] - pts[i * 3 + 2]) * s);
                }
                if (level === high) break;
            }
        }
    }
    if (slice.length === 0) return null;

    // Padded as a Minkowski sum with a circumscribed polygon, so the clearance is never under `radius`.
    // It also turns a degenerate slice -- one point, one segment -- into a real polygon for free.
    let padded = slice;
    if (radius > 0) {
        const r = radius / Math.cos(Math.PI / PAD_DIRECTIONS);
        const core = convexHull2D(slice);
        const base = core.length > 0 ? core : slice;
        padded = [];
        for (let i = 0; i < base.length; i += 2) {
            for (let k = 0; k < PAD_DIRECTIONS; k++) {
                const angle = (k / PAD_DIRECTIONS) * Math.PI * 2;
                padded.push(base[i] + Math.cos(angle) * r, base[i + 1] + Math.sin(angle) * r);
            }
        }
    }
    const hull = convexHull2D(padded);
    return hull.length >= 6 ? hull : null;
}

/** Andrew's monotone chain over flat `[x, z, ...]`: CCW in (x, z), collinear points dropped. */
function convexHull2D(flat: readonly number[]): number[] {
    const order: number[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) order.push(i);
    order.sort((p, q) => flat[p] - flat[q] || flat[p + 1] - flat[q + 1]);
    const cross = (o: number, p: number, q: number) =>
        (flat[p] - flat[o]) * (flat[q + 1] - flat[o + 1]) - (flat[p + 1] - flat[o + 1]) * (flat[q] - flat[o]);
    const chain = (indices: number[]) => {
        const out: number[] = [];
        for (const p of indices) {
            while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 1e-12) out.pop();
            out.push(p);
        }
        out.pop();
        return out;
    };
    const ring = chain(order).concat(chain([...order].reverse()));
    const out: number[] = [];
    for (const p of ring) out.push(flat[p], flat[p + 1]);
    return out;
}

/** Every piece minus one convex CCW footprint: still convex pieces, with the footprint's interior gone. */
function subtractFootprint(pieces: number[][][], footprint: readonly number[]): number[][][] {
    const out: number[][][] = [];
    const m = footprint.length / 2;
    for (const piece of pieces) {
        let rest: number[][] = piece;
        for (let i = 0; i < m && rest.length >= 3; i++) {
            const px = footprint[i * 2], pz = footprint[i * 2 + 1];
            const ex = footprint[((i + 1) % m) * 2] - px, ez = footprint[((i + 1) % m) * 2 + 1] - pz;
            // Positive on the footprint's inside: left of a CCW edge in (x, z).
            const side = (p: readonly number[]) => ex * (p[2] - pz) - ez * (p[0] - px);
            const outside = clipByDistance(rest, p => -side(p));
            if (outside.length >= 3) out.push(outside);
            rest = clipByDistance(rest, side);
        }
        // What is left lies inside every edge: the obstructed part, dropped.
    }
    return out;
}

/** Sutherland-Hodgman against `distance(p) >= 0`, interpolating all three coordinates. */
function clipByDistance(poly: readonly number[][], distance: (p: readonly number[]) => number): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < poly.length; i++) {
        const current = poly[i];
        const next = poly[(i + 1) % poly.length];
        const dc = distance(current);
        const dn = distance(next);
        if (dc >= 0) out.push(current);
        if ((dc > 0 && dn < 0) || (dc < 0 && dn > 0)) {
            const t = dc / (dc - dn);
            out.push([
                current[0] + (next[0] - current[0]) * t,
                current[1] + (next[1] - current[1]) * t,
                current[2] + (next[2] - current[2]) * t,
            ]);
        }
    }
    return out;
}
