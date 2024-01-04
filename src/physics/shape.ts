import { Shape as CannonShape, 
    Box, Sphere, Cylinder, Plane, Trimesh,
    Vec3 } from "cannon";
import { vec3 } from "gl-matrix";
import { Geometry } from "../core/geometry";

export class Shape {
    private _shape: CannonShape;

    constructor(shape: CannonShape) {
        this._shape = shape;
    }

    public static Box(width: number, height: number, depth: number): Shape {
        return new Shape(new Box(new Vec3(width / 2, height / 2, depth / 2)));
    }

    public static Sphere(radius: number): Shape {
        return new Shape(new Sphere(radius));
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

    public get cShape(): CannonShape { return this._shape; }

}