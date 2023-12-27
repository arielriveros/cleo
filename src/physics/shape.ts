import { Shape as CannonShape, 
    Box, Sphere, Cylinder, Plane,
    Vec3 } from "cannon";

export class Shape {
    private _shape: CannonShape;

    constructor(shape: CannonShape) {
        this._shape = shape;
    }

    public static Box(width: number, height: number, depth: number): Shape {
        return new Shape(new Box(new Vec3(width, height, depth)));
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

    public get cShape(): CannonShape { return this._shape; }

}