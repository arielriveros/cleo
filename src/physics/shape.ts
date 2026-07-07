import { Shape as CannonShape,
    Box, Sphere, Cylinder, Plane, Trimesh, Heightfield,
    Vec3 } from "cannon-es";
import { vec3 } from "gl-matrix";
import { Geometry } from "../core/geometry";
import { Model } from "../graphics/model";
import { Material } from "../graphics/material";

const EPSILON = 0.01;

export class Shape {
    private _shape: CannonShape;
    private _debugModel: Model | null = null;

    constructor(shape: CannonShape, debugGeometry?: Geometry) {
        this._shape = shape;
        if (debugGeometry) {
            this._debugModel = new Model( debugGeometry, Material.Basic({}, {wireframe: true, side: 'double' }) );

        }
    }

    public static Box(width: number, height: number, depth: number): Shape {
        return new Shape( new Box(new Vec3(width / 2, height / 2, depth / 2)), Geometry.Cube(width + EPSILON, height + EPSILON, depth + EPSILON) );
    }

    public static Sphere(radius: number): Shape {
        return new Shape(new Sphere(radius), Geometry.Sphere(16, radius + EPSILON));
    }

    public static Cylinder(radiusTop: number, radiusBottom: number, height: number, numSegments: number): Shape {
        return new Shape(new Cylinder(radiusTop, radiusBottom, height, numSegments));
    }

    public static Plane(): Shape {
        return new Shape(new Plane());
    }

    /**
     * Currently trimeshes only support plane and sphere collision detection
     * @param geometry to get the positions and indices from
     * @returns trimesh shape
     */
    public static TriMesh(geometry: Geometry, scale: vec3 = vec3.fromValues(1, 1, 1)): Shape {
        const vertices = geometry.positions;
        const indices = geometry.indices;
        const numVertices: number[] = [];
        for (const v of vertices) numVertices.push(v[0], v[1], v[2]);

        const trimesh = new Trimesh(numVertices, indices);
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
    public get debugModel(): Model | null { return this._debugModel; }

}