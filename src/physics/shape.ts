import { Shape as CannonShape,
    Box, Sphere, Cylinder, Plane, Trimesh, Heightfield, ConvexPolyhedron,
    Vec3 } from "cannon-es";
import { vec3 } from "gl-matrix";
import { Geometry } from "../core/geometry";
import { Model } from "../graphics/model";
import { Material } from "../graphics/material";

const EPSILON = 0.01;

/**
 * Every factory takes the owner node's world scale, since shape dimensions are authored in node-local
 * units. Only convex hulls and boxes can honor a non-uniform scale exactly; spheres and cylinders
 * have no ellipsoid equivalent in cannon, so they fall back to the dominant axis.
 */
const NO_SCALE: vec3 = [1, 1, 1];
const absScale = (s: vec3): vec3 => [Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])];

export class Shape {
    private _shape: CannonShape;
    private _debugGeometry: Geometry | null;
    private _debugModel: Model | null = null;

    constructor(shape: CannonShape, debugGeometry?: Geometry) {
        this._shape = shape;
        // The debug model is built lazily: constructing a Model allocates GPU buffers, and shapes
        // are created for every collider in published games where the wireframe is never drawn.
        this._debugGeometry = debugGeometry ?? null;
    }

    public static Box(width: number, height: number, depth: number, scale: vec3 = NO_SCALE): Shape {
        const [sx, sy, sz] = absScale(scale);
        const w = width * sx, h = height * sy, d = depth * sz;
        return new Shape( new Box(new Vec3(w / 2, h / 2, d / 2)), Geometry.Cube(w + EPSILON, h + EPSILON, d + EPSILON) );
    }

    public static Sphere(radius: number, scale: vec3 = NO_SCALE): Shape {
        const [sx, sy, sz] = absScale(scale);
        const r = radius * Math.max(sx, sy, sz);
        return new Shape(new Sphere(r), Geometry.Sphere(16, r + EPSILON));
    }

    public static Cylinder(radiusTop: number, radiusBottom: number, height: number, numSegments: number, scale: vec3 = NO_SCALE): Shape {
        const [sx, sy, sz] = absScale(scale);
        const radial = Math.max(sx, sz);
        return new Shape(new Cylinder(radiusTop * radial, radiusBottom * radial, height * sy, numSegments));
    }

    /**
     * Capsule collider — the right shape for a character. cannon has no capsule primitive (its SHAPE_TYPES
     * stop at cylinder), so one is compounded from a cylinder and two spheres; this returns the parts and
     * the caller attaches each at its offset. That matters beyond convenience: cannon's Cylinder is a
     * faceted ConvexPolyhedron, but Sphere is analytic — a character rests on the bottom sphere cap and so
     * rolls over heightfield triangle edges instead of catching on them, which a box does.
     *
     * `height` is the TOTAL tip-to-tip height (Unity/Godot convention), so the straight section is
     * `height - 2 * radius`. At or below `2 * radius` there is no straight section and the capsule is just
     * a sphere — reachable by authoring, but also by a non-uniform scale, since the radius grows radially
     * while the height follows Y.
     *
     * Offsets are in scaled body space and lie along the capsule's local Y, BEFORE the shape's own
     * rotation — `attachShape` does not rotate offsets, so a caller applying a rotation must rotate these
     * to match.
     */
    public static Capsule(radius: number, height: number, numSegments: number, scale: vec3 = NO_SCALE): { shape: Shape; offset: vec3 }[] {
        const [sx, sy, sz] = absScale(scale);
        const r = radius * Math.max(sx, sz);
        const cyl = Math.max(0, height * sy - 2 * r);

        if (cyl <= EPSILON)
            return [{ shape: new Shape(new Sphere(r), Geometry.Sphere(16, r + EPSILON)), offset: [0, 0, 0] }];

        // Only the cylinder carries debug geometry, and it carries the WHOLE capsule's — otherwise the
        // three parts would draw three overlapping wireframes for one collider.
        return [
            { shape: new Shape(new Cylinder(r, r, cyl, numSegments), Geometry.Capsule(numSegments, r + EPSILON, cyl)), offset: [0, 0, 0] },
            { shape: new Shape(new Sphere(r)), offset: [0, cyl / 2, 0] },
            { shape: new Shape(new Sphere(r)), offset: [0, -cyl / 2, 0] },
        ];
    }

    public static Plane(): Shape {
        return new Shape(new Plane());
    }

    /**
     * Convex hull collider. `vertices` / `faces` come from `convexHull.ts` (faces are index loops wound
     * CCW from outside, and the hull is centered on its own centroid — cannon validates face planes
     * against the origin). Returns null for a degenerate hull so the caller can fall back.
     *
     * cannon-es collides convex polyhedra with convex, box, sphere, plane, cylinder, heightfield and
     * particle shapes. There is no convex/trimesh narrowphase.
     */
    public static ConvexHull(vertices: number[][], faces: number[][], scale: vec3 = NO_SCALE): Shape | null {
        if (vertices.length < 4 || faces.length < 4) return null;
        const [sx, sy, sz] = absScale(scale);

        const scaled = vertices.map(v => [v[0] * sx, v[1] * sy, v[2] * sz] as [number, number, number]);
        const hull = new ConvexPolyhedron({
            vertices: scaled.map(v => new Vec3(v[0], v[1], v[2])),
            faces: faces.map(f => [...f]),
        });

        return new Shape(hull, Geometry.ConvexHull(scaled, faces));
    }

    /**
     * Currently trimeshes only support plane and sphere collision detection
     * @param geometry to get the positions and indices from
     * @returns trimesh shape
     */
    public static TriMesh(geometry: Geometry, scale: vec3 = vec3.fromValues(1, 1, 1)): Shape {
        // cannon's Trimesh wants plain arrays; Geometry stores flat typed arrays, so this is a
        // straight widening rather than the per-vertex unpack it used to be.
        const trimesh = new Trimesh(Array.from(geometry.positions), Array.from(geometry.indices));
        trimesh.setScale(new Vec3( scale[0], scale[1], scale[2]));
        return new Shape(trimesh);
    }

    /**
     * Heightfield collider for terrain. `data` is a row-major 2D array of heights (data[i][j], i along the
     * local X axis, j along the local Y axis; height is along local Z). cannon-es collides Heightfield with
     * Sphere/Box/Convex/Cylinder bodies, so any mesh using those shapes is walkable. `elementSize` is the
     * world spacing between adjacent samples. The owning body should be rotated -90° about X so the field
     * lies in the world XZ plane with height along world Y (handled by the Terrain subsystem).
     */
    public static Heightfield(data: number[][], elementSize: number): Shape {
        return new Shape(new Heightfield(data, { elementSize }));
    }

    public get cShape(): CannonShape { return this._shape; }
    public get debugModel(): Model | null {
        if (!this._debugModel && this._debugGeometry)
            this._debugModel = new Model( this._debugGeometry, Material.Basic({}, {wireframe: true, side: 'double' }) );
        return this._debugModel;
    }

}