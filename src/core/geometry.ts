import { vec2, vec3 } from "gl-matrix";

export class Geometry {
    private readonly _positions: vec3[];
    private readonly _normals: vec3[];
    private readonly _uvs: vec2[];
    private readonly _indices: number[];

    constructor(
        positions: vec3[] = [],
        normals: vec3[] = [],
        uvs: vec2[] = [],
        indices: number[] = []
    ) {
        this._positions = positions;
        this._normals = normals;
        this._uvs = uvs;
        this._indices = indices;
    }

    public get positions(): vec3[] { return this._positions; }
    public get normals(): vec3[] { return this._normals; }
    public get uvs(): vec2[] { return this._uvs; }
    public get indices(): number[] { return this._indices; }
    public get vertexCount(): number { return this._positions.length / 3; }
    public getData(attributes: string[] = []): number[] {
        const interleaved: number[] = [];

        for (let i = 0; i < this._positions.length; i++) {
            if (attributes.includes('position')) {
                interleaved.push(this._positions[i][0]);
                interleaved.push(this._positions[i][1]);
                interleaved.push(this._positions[i][2]);
            }

            if (this._normals.length > 0 && attributes.includes('normal')) {
                interleaved.push(this._normals[i][0]);
                interleaved.push(this._normals[i][1]);
                interleaved.push(this._normals[i][2]);
            }

            if (this._uvs.length > 0 && attributes.includes('uv')) {
                interleaved.push(this._uvs[i][0]);
                interleaved.push(this._uvs[i][1]);
            }
        }

        return interleaved;
    }

    public static Triangle(base: number = 1, height: number = 1): Geometry {
        return new Geometry(
            [
                vec3.fromValues(-base/2, -height/2, 0.0),
                vec3.fromValues(base/2, -height/2, 0.0),
                vec3.fromValues(0.0, height/2, 0.0)
            ],
            [
                vec3.fromValues(0.0, 0.0, 1.0),
                vec3.fromValues(0.0, 0.0, 1.0),
                vec3.fromValues(0.0, 0.0, 1.0)
            ],
            [
                vec2.fromValues(0.0, 0.0),
                vec2.fromValues(1.0, 0.0),
                vec2.fromValues(0.5, 1.0)
            ],
            [0, 1, 2]
        );
    }

    public static Quad(base: number = 1, height: number = 1): Geometry {
        return new Geometry(
            [
                vec3.fromValues(-base/2, -height/2, 0.0),
                vec3.fromValues(base/2, -height/2, 0.0),
                vec3.fromValues(base/2, height/2, 0.0),
                vec3.fromValues(-base/2, height/2, 0.0)
            ],
            [
                vec3.fromValues(0.0, 0.0, 1.0),
                vec3.fromValues(0.0, 0.0, 1.0),
                vec3.fromValues(0.0, 0.0, 1.0),
                vec3.fromValues(0.0, 0.0, 1.0)
            ],
            [
                vec2.fromValues(0.0, 0.0),
                vec2.fromValues(1.0, 0.0),
                vec2.fromValues(1.0, 1.0),
                vec2.fromValues(0.0, 1.0)
            ],
            [0, 1, 2, 0, 2, 3]
        );
    }

    public static Circle(diameter: number = 1, segments: number = 32): Geometry {
        const positions: vec3[] = [];
        const normals: vec3[] = [];
        const uvs: vec2[] = [];
        const indices: number[] = [];

        const angle = 2 * Math.PI / segments;
        const radius = diameter / 2;

        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const y = radius * Math.sin(angle * i);

            positions.push(vec3.fromValues(x, y, 0.0));
            normals.push(vec3.fromValues(0.0, 0.0, 1.0));
            uvs.push(vec2.fromValues(0.5 + x / radius / 2, 0.5 + y / radius / 2));

            indices.push(0);
            indices.push(i + 1);
            indices.push(i + 2);
        }

        return new Geometry(positions, normals, uvs, indices);
    }

    public static Cube(width: number = 1, height: number = 1, depth: number = 1): Geometry {
        const positions: vec3[] = [];
        const normals: vec3[] = [];
        const uvs: vec2[] = [];
        const indices: number[] = [];

        const vertices = [
            vec3.fromValues(-width/2, -height/2, depth/2),
            vec3.fromValues(width/2, -height/2, depth/2),
            vec3.fromValues(width/2, height/2, depth/2),
            vec3.fromValues(-width/2, height/2, depth/2),
            vec3.fromValues(-width/2, -height/2, -depth/2),
            vec3.fromValues(width/2, -height/2, -depth/2),
            vec3.fromValues(width/2, height/2, -depth/2),
            vec3.fromValues(-width/2, height/2, -depth/2)
        ];

        const faces = [
            [0, 1, 2, 3],
            [1, 5, 6, 2],
            [5, 4, 7, 6],
            [4, 0, 3, 7],
            [3, 2, 6, 7],
            [4, 5, 1, 0]
        ];

        const faceNormals = [
            vec3.fromValues(0.0, 0.0, 1.0),
            vec3.fromValues(1.0, 0.0, 0.0),
            vec3.fromValues(0.0, 0.0, -1.0),
            vec3.fromValues(-1.0, 0.0, 0.0),
            vec3.fromValues(0.0, 1.0, 0.0),
            vec3.fromValues(0.0, -1.0, 0.0)
        ];

        const faceUVs = [
            vec2.fromValues(0.0, 0.0),
            vec2.fromValues(1.0, 0.0),
            vec2.fromValues(1.0, 1.0),
            vec2.fromValues(0.0, 1.0)
        ];

        for (let i = 0; i < faces.length; i++) {
            for (let j = 0; j < faces[i].length; j++) {
                positions.push(vertices[faces[i][j]]);
                normals.push(faceNormals[i]);
                uvs.push(faceUVs[j]);
            }
            indices.push(i * 4 + 0);
            indices.push(i * 4 + 1);
            indices.push(i * 4 + 2);
            indices.push(i * 4 + 0);
            indices.push(i * 4 + 2);
            indices.push(i * 4 + 3);
    }

        return new Geometry(positions, normals, uvs, indices);
    }
}