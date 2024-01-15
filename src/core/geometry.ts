import { vec2, vec3 } from "gl-matrix";

export class Geometry {
    private readonly _positions: vec3[];
    private readonly _normals: vec3[];
    private readonly _uvs: vec2[];
    private _tangents!: vec3[];
    private _bitangents!: vec3[];
    private readonly _indices: number[];

    constructor(
        positions: vec3[] = [],
        normals: vec3[] = [],
        uvs: vec2[] = [],
        tangents: vec3[] = [],
        bitangents: vec3[] = [],
        indices: number[] = []
    ) {
        this._positions = positions;
        this._normals = normals;
        this._uvs = uvs;
        this._tangents = tangents;
        this._bitangents = bitangents;        
        this._indices = indices;

        if (this._tangents.length === 0 || this._bitangents.length === 0)
            this._calculateTangents();
    }

    public get positions(): vec3[] { return this._positions; }
    public get normals(): vec3[] { return this._normals; }
    public get uvs(): vec2[] { return this._uvs; }
    public get indices(): number[] { return this._indices; }
    public get vertexCount(): number { return this._positions.length * 3; }
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

            if (this._tangents?.length > 0 && attributes.includes('tangent')) {
                interleaved.push(this._tangents[i][0]);
                interleaved.push(this._tangents[i][1]);
                interleaved.push(this._tangents[i][2]);
            }

            if (this._bitangents?.length > 0 && attributes.includes('bitangent')) {
                interleaved.push(this._bitangents[i][0]);
                interleaved.push(this._bitangents[i][1]);
                interleaved.push(this._bitangents[i][2]);
            }
        }

        return interleaved;
    }
    private _calculateTangents(): void {
        const faces: number[][] = []
        for (let i = 0; i < this._indices.length; i+=3)
            faces.push([this._indices[i], this._indices[i+1], this._indices[i+2]]);

        for (let face of faces) {
            const v0 = this._positions[face[0]];
            const v1 = this._positions[face[1]];
            const v2 = this._positions[face[2]];
            
            const uv0 = this._uvs[face[0]];
            const uv1 = this._uvs[face[1]];
            const uv2 = this._uvs[face[2]];
            
            const edge1 = vec3.subtract(vec3.create(), v1, v0);
            const edge2 = vec3.subtract(vec3.create(), v2, v0);
            
            const deltaUV1 = vec2.subtract(vec2.create(), uv1, uv0);
            const deltaUV2 = vec2.subtract(vec2.create(), uv2, uv0);
            
            const f = 1.0 / (deltaUV1[0] * deltaUV2[1] - deltaUV2[0] * deltaUV1[1]);

            const x = f * (deltaUV2[1] * edge1[0] - deltaUV1[1] * edge2[0]);
            const y = f * (deltaUV2[1] * edge1[1] - deltaUV1[1] * edge2[1]);
            const z = f * (deltaUV2[1] * edge1[2] - deltaUV1[1] * edge2[2]);
            const tangent = vec3.fromValues(x, y, z);
            this._tangents.push(tangent, tangent);

            const bigangent =vec3.cross(vec3.create(), this._normals[face[0]], tangent);
            vec3.scale(bigangent, bigangent, -1.0)
            this._bitangents.push(bigangent, bigangent);
        }
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
            [
                vec3.fromValues(1.0, 0.0, 0.0),
                vec3.fromValues(1.0, 0.0, 0.0),
                vec3.fromValues(1.0, 0.0, 0.0)
            ],
            [
                vec3.fromValues(0.0, 1.0, 0.0),
                vec3.fromValues(0.0, 1.0, 0.0),
                vec3.fromValues(0.0, 1.0, 0.0)
            ],
            [0, 1, 2],
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
            [
                vec3.fromValues(1.0, 0.0, 0.0),
                vec3.fromValues(1.0, 0.0, 0.0),
                vec3.fromValues(1.0, 0.0, 0.0),
                vec3.fromValues(1.0, 0.0, 0.0)
            ],
            [
                vec3.fromValues(0.0, 1.0, 0.0),
                vec3.fromValues(0.0, 1.0, 0.0),
                vec3.fromValues(0.0, 1.0, 0.0),
                vec3.fromValues(0.0, 1.0, 0.0)
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

        return new Geometry(positions, normals, uvs, [], [], indices);
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

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    public static Sphere(segments: number = 32, radius: number = 1): Geometry {
        const positions: vec3[] = [];
        const normals: vec3[] = [];
        const uvs: vec2[] = [];
        const indices: number[] = [];

        for (let i = 0; i <= segments; ++i)
        {
            let v = i / segments;
            let phi = v * Math.PI;

            for (let j = 0; j <= segments; ++j)
            {
                let u = j / segments;
                let theta = u * 2 * Math.PI;

                const x = Math.cos(theta) * Math.sin(phi) * radius;
                const y = Math.cos(phi) * radius;
                const z = Math.sin(theta) * Math.sin(phi) * radius;

                let pos = vec3.fromValues(x, y, z);
                let uv = vec2.fromValues((segments - j) / segments, v);
                let nor = vec3.normalize(vec3.create(), pos);

                positions.push(pos);
                uvs.push(uv);
                normals.push(nor);
            }
        }

        // Generate indices
        for (let i = 0; i < segments; ++i)
            for (let j = 0; j < segments; ++j)
            {
                let k1 = i * (segments + 1) + j;
                let k2 = k1 + segments + 1;

                indices.push(k1);
                indices.push(k1 + 1);
                indices.push(k2);

                indices.push(k2);
                indices.push(k1 + 1);
                indices.push(k2 + 1);
            }


        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    public static async Terrain(heightmapPath: string): Promise<Geometry> {
        return new Promise<Geometry>((resolve, reject) => {
            const positions: vec3[] = [];
            const normals: vec3[] = [];
            const uvs: vec2[] = [];
            const indices: number[] = [];

            const image = new Image();
            image.src = heightmapPath;

            image.onload = () => {
                const width = image.width;
                const height = image.height;

                const halfWidth = width / 2;
                const halfHeight = height / 2;

                let data = null;
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext('2d');
                if (!context) {
                    reject();
                    return;
                }
                    
                context.drawImage(image, 0, 0);
                data = context.getImageData(0, 0, width, height).data;

                // calculate amplitude based on width and height of the image
                const amplitude = Math.sqrt(Math.max(width, height)) / 2;

                for (let i = 0; i <= width; i++) {
                    for (let j = 0; j <= height; j++) {
                        const x = -halfWidth + j;
                        const y = ((data[(i * height + j) * 4] / 255 ) * 2 - 1) * amplitude;
                        const z = halfHeight - i;

                        positions.push(vec3.fromValues(x, y, z));
                        uvs.push(vec2.fromValues(j / height, i / width));
                        // calculate normal
                        let normal = vec3.fromValues(0.0, 0.0, 0.0);
                        if (i > 0 && j > 0) {
                            const v1 = vec3.subtract(vec3.create(), positions[i * (height + 1) + j], positions[(i - 1) * (height + 1) + j]);
                            const v2 = vec3.subtract(vec3.create(), positions[i * (height + 1) + j], positions[i * (height + 1) + j - 1]);
                            normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), v2, v1));
                        }
                        normals.push(normal);
                    }
                }

                for (let i = 0; i < width - 1; i++) {
                    for (let j = 0; j < height - 1; j++) {
                        const topLeft = i * (height + 1) + j;
                        const topRight = topLeft + 1;
                        const bottomLeft = (i + 1) * (height + 1) + j;
                        const bottomRight = bottomLeft + 1;
                
                        // Change the order of indices to create triangles in a counter-clockwise direction
                        indices.push(topLeft, topRight, bottomLeft);
                        indices.push(topRight, bottomRight, bottomLeft);
                    }
                }

                resolve(new Geometry(positions, normals, uvs, [], [], indices));
            }
        });
    }
}