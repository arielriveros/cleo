import { vec3 } from "gl-matrix";
import { Geometry } from "../core/geometry";
import { Model } from "../graphics/model";
import { Material } from "../graphics/material";
import type { ShapeDesc } from "./pal/types";

const EPSILON = 0.01;

/**
 * Every factory takes the owner node's world scale, since shape dimensions are authored in node-local
 * units. Only convex hulls and boxes can honor a non-uniform scale exactly; spheres and cylinders have no
 * ellipsoid equivalent, so they fall back to the dominant axis.
 */
const NO_SCALE: vec3 = [1, 1, 1];
const absScale = (s: vec3): vec3 => [Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])];

/**
 * A collision shape: what it is, as plain data (`desc`, a backend-neutral ShapeDesc — see
 * physics/pal/types.ts), and the wireframe the editor draws for it. Dimensions are final: the factories
 * apply the owner's scale.
 */
export class Shape {
    /** The shape, as every physics backend reads it. */
    public readonly desc: ShapeDesc;
    private _debugGeometry: Geometry | null;
    private _debugModel: Model | null = null;

    constructor(desc: ShapeDesc, debugGeometry?: Geometry) {
        this.desc = desc;
        this._debugGeometry = debugGeometry ?? null;
    }

    public static Box(width: number, height: number, depth: number, scale: vec3 = NO_SCALE): Shape {
        const [sx, sy, sz] = absScale(scale);
        const w = width * sx, h = height * sy, d = depth * sz;
        return new Shape({ kind: 'box', halfExtents: [w / 2, h / 2, d / 2] }, Geometry.Cube(w + EPSILON, h + EPSILON, d + EPSILON));
    }

    public static Sphere(radius: number, scale: vec3 = NO_SCALE): Shape {
        const [sx, sy, sz] = absScale(scale);
        const r = radius * Math.max(sx, sy, sz);
        return new Shape({ kind: 'sphere', radius: r }, Geometry.Sphere(16, r + EPSILON));
    }

    public static Cylinder(radiusTop: number, radiusBottom: number, height: number, numSegments: number, scale: vec3 = NO_SCALE): Shape {
        const [sx, sy, sz] = absScale(scale);
        const radial = Math.max(sx, sz);
        return new Shape({ kind: 'cylinder', radiusTop: radiusTop * radial, radiusBottom: radiusBottom * radial, height: height * sy, segments: numSegments });
    }

    /**
     * Capsule collider, returned as the parts of a compound (a cylinder and two spheres) for the caller to
     * attach at each offset — the form every backend can simulate. `height` is the TOTAL tip-to-tip height,
     * so the straight section is `height - 2 * radius`; at or below `2 * radius` it degenerates to a sphere.
     * Offsets are in scaled body space along local Y, BEFORE the shape's own rotation — `attachShape` does
     * not rotate offsets, so a caller applying a rotation must rotate these to match.
     */
    public static Capsule(radius: number, height: number, numSegments: number, scale: vec3 = NO_SCALE): { shape: Shape; offset: vec3 }[] {
        const [sx, sy, sz] = absScale(scale);
        const r = radius * Math.max(sx, sz);
        const cyl = Math.max(0, height * sy - 2 * r);

        if (cyl <= EPSILON)
            return [{ shape: new Shape({ kind: 'sphere', radius: r }, Geometry.Sphere(16, r + EPSILON)), offset: [0, 0, 0] }];

        // Only the cylinder carries debug geometry, and it carries the WHOLE capsule's: three parts would
        // otherwise draw three overlapping wireframes for one collider.
        return [
            { shape: new Shape({ kind: 'cylinder', radiusTop: r, radiusBottom: r, height: cyl, segments: numSegments }, Geometry.Capsule(numSegments, r + EPSILON, cyl)), offset: [0, 0, 0] },
            { shape: new Shape({ kind: 'sphere', radius: r }), offset: [0, cyl / 2, 0] },
            { shape: new Shape({ kind: 'sphere', radius: r }), offset: [0, -cyl / 2, 0] },
        ];
    }

    public static Plane(): Shape {
        return new Shape({ kind: 'plane' });
    }

    /**
     * Convex hull collider. `vertices` / `faces` come from `convexHull.ts`: faces are index loops wound CCW
     * from outside and the hull must be centered on its own centroid (cannon validates face planes against
     * the origin). Returns null for a degenerate hull. There is no convex/trimesh narrowphase.
     */
    public static ConvexHull(vertices: number[][], faces: number[][], scale: vec3 = NO_SCALE): Shape | null {
        if (vertices.length < 4 || faces.length < 4) return null;
        const [sx, sy, sz] = absScale(scale);

        const scaled = vertices.map(v => [v[0] * sx, v[1] * sy, v[2] * sz] as [number, number, number]);
        return new Shape({ kind: 'convex', vertices: scaled, faces: faces.map(f => [...f]) }, Geometry.ConvexHull(scaled, faces));
    }

    /**
     * Currently trimeshes only support plane and sphere collision detection
     * @param geometry to get the positions and indices from
     * @returns trimesh shape
     */
    public static TriMesh(geometry: Geometry, scale: vec3 = vec3.fromValues(1, 1, 1)): Shape {
        return new Shape({ kind: 'trimesh', positions: geometry.positions, indices: geometry.indices, scale: [scale[0], scale[1], scale[2]] });
    }

    /**
     * Heightfield collider for terrain: `data[i][j]` is the height at (i, j), i along the body's +X and j along
     * its -Z from the body's origin, heights along +Y, `elementSize` apart. Collides with sphere, box, convex
     * and cylinder bodies, so any mesh using those shapes is walkable.
     */
    public static Heightfield(data: number[][], elementSize: number): Shape {
        return new Shape({ kind: 'heightfield', heights: data, elementSize });
    }

    public get debugModel(): Model | null {
        if (!this._debugModel && this._debugGeometry)
            this._debugModel = new Model( this._debugGeometry, Material.Basic({}, {wireframe: true, side: 'double' }) );
        return this._debugModel;
    }

}
