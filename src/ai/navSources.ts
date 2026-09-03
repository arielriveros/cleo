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
 * ## Spheres and capsules are deliberately skipped
 *
 * Neither offers a walkable surface: the slope filter would keep only a degenerate patch at the very
 * top, which is not somewhere an agent can stand. Treating them as OBSTACLES — subtracting them from
 * the walkable area — is a different operation the baker does not do, so pretending otherwise would
 * be worse than leaving them out. Same for a `plane`, which is an infinite half-space in cannon and
 * has no honest finite tessellation; the caller supplies an extent if it wants one.
 */

import { mat4, vec3 } from "gl-matrix";
import type { TriangleSoup } from "./navBake";

/** A collider shape, stripped to what tessellation needs. */
export type NavPrimitive =
    | { kind: 'box'; size: readonly [number, number, number] }
    | { kind: 'cylinder'; radius: number; height: number; segments?: number }
    | { kind: 'convex'; vertices: readonly (readonly number[])[]; faces: readonly (readonly number[])[] }
    /** Cannon's plane is an infinite half-space; `extent` is how much of it to actually emit. */
    | { kind: 'plane'; extent: number };

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
