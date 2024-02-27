import { vec2, vec3 } from "gl-matrix";
import { Loader } from "../cleo";

export class Geometry {
    private readonly _positions: [number, number, number][];
    private readonly _normals: [number, number, number][];
    private readonly _uvs: [number, number][];
    private _tangents!: [number, number, number][];
    private _bitangents!: [number, number, number][];
    private readonly _indices: number[];

    constructor(
        positions: [number, number, number][] = [],
        normals: [number, number, number][] = [],
        uvs: [number, number][] = [],
        tangents: [number, number, number][] = [],
        bitangents: [number, number, number][] = [],
        indices: number[] = [],
        calculateTangents: boolean = true
    ) {
        this._positions = positions;
        this._normals = normals;
        this._uvs = uvs;
        this._tangents = tangents;
        this._bitangents = bitangents;        
        this._indices = indices;

        if ((this._tangents.length === 0 || this._bitangents.length === 0) && calculateTangents)
            this._calculateTangents();
    }

    public get positions(): number[][] { return this._positions; }
    public get normals(): number[][] { return this._normals; }
    public get uvs(): number[][] { return this._uvs; }
    public get indices(): number[] { return this._indices; }
    public get tangents(): number[][] { return this._tangents; }
    public get bitangents(): number[][] { return this._bitangents; }
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
            const edge1 = vec3.fromValues(v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]);
            const edge2 = vec3.fromValues(v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]);
            const deltaUV1 = vec2.fromValues(uv1[0] - uv0[0], uv1[1] - uv0[1]);
            const deltaUV2 = vec2.fromValues(uv2[0] - uv0[0], uv2[1] - uv0[1]);
            
            const f = 1.0 / (deltaUV1[0] * deltaUV2[1] - deltaUV2[0] * deltaUV1[1]);

            const x = f * (deltaUV2[1] * edge1[0] - deltaUV1[1] * edge2[0]);
            const y = f * (deltaUV2[1] * edge1[1] - deltaUV1[1] * edge2[1]);
            const z = f * (deltaUV2[1] * edge1[2] - deltaUV1[1] * edge2[2]);
            const tangent: [number, number, number] = [x, y, z]
            this._tangents.push(tangent, tangent);

            const vecBigangent = vec3.fromValues(this._normals[face[0]][1] * tangent[2] - this._normals[face[0]][2] * tangent[1],
                                              this._normals[face[0]][2] * tangent[0] - this._normals[face[0]][0] * tangent[2],
                                              this._normals[face[0]][0] * tangent[1] - this._normals[face[0]][1] * tangent[0]);
            vec3.scale(vecBigangent, vecBigangent, -1.0)
            this._bitangents.push([vecBigangent[0], vecBigangent[1], vecBigangent[2]], [vecBigangent[0], vecBigangent[1], vecBigangent[2]]);
        }
    }

    public static Triangle(base: number = 1, height: number = 1): Geometry {
        return new Geometry(
            [
                [-base/2, -height/2, 0.0],
                [base/2, -height/2, 0.0],
                [0.0, height/2, 0.0]
            ],
            [
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0]
            ],
            [
                [0.0, 0.0],
                [1.0, 0.0],
                [0.5, 1.0]
            ],
            [
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0]
            ],
            [
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0]
            ],
            [0, 1, 2],
        );
    }

    public static Quad(base: number = 1, height: number = 1): Geometry {
        return new Geometry(
            [
                [-base/2, -height/2, 0.0],
                [base/2, -height/2, 0.0],
                [base/2, height/2, 0.0],
                [-base/2, height/2, 0.0]
            ],
            [
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0]
            ],
            [
                [0.0, 0.0],
                [1.0, 0.0],
                [1.0, 1.0],
                [0.0, 1.0]
            ],
            [
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0]
            ],
            [
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0]
            ],
            [0, 1, 2, 0, 2, 3]
        );
    }

    public static Circle(diameter: number = 1, segments: number = 32): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const angle = 2 * Math.PI / segments;
        const radius = diameter / 2;

        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const y = radius * Math.sin(angle * i);

            positions.push([x, y, 0.0]);
            normals.push([0.0, 0.0, 1.0]);
            uvs.push([0.5 + x / radius / 2, 0.5 + y / radius / 2]);

            indices.push(0);
            indices.push(i + 1);
            indices.push(i + 2);
        }

        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    public static Cube(width: number = 1, height: number = 1, depth: number = 1, asWireframe: boolean = false): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];

        const vertices: [number, number, number][] = [
            [-width/2, -height/2, depth/2],
            [width/2, -height/2, depth/2],
            [width/2, height/2, depth/2],
            [-width/2, height/2, depth/2],
            [-width/2, -height/2, -depth/2],
            [width/2, -height/2, -depth/2],
            [width/2, height/2, -depth/2],
            [-width/2, height/2, -depth/2]
        ];

        const faces = [
            [0, 1, 2, 3], // front
            [1, 5, 6, 2], // right
            [5, 4, 7, 6], // back
            [4, 0, 3, 7], // left
            [3, 2, 6, 7], // top
            [4, 5, 1, 0]  // bottom
        ];

        const faceNormals: [number, number, number][] = [
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            [-1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0]
        ];

        const faceUVs: [number, number][] = [
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 1.0],
            [0.0, 1.0]
        ];


        for (let i = 0; i < faces.length; i++) {
            for (let j = 0; j < faces[i].length; j++) {
                positions.push(vertices[faces[i][j]]);
                normals.push(faceNormals[i]);
                uvs.push(faceUVs[j]);
            }
            if (!asWireframe) {
                indices.push(i * 4 + 0);
                indices.push(i * 4 + 1);
                indices.push(i * 4 + 2);
                indices.push(i * 4 + 0);
                indices.push(i * 4 + 2);
                indices.push(i * 4 + 3);
            }
        }

        if (asWireframe) {
            indices.push(0, 1, 1, 2, 2, 3, 3, 0);
            indices.push(1, 5, 5, 6, 6, 2);
            indices.push(0, 9, 9, 10, 10, 3);
            indices.push(5, 9, 6, 10);
        }
        
        return new Geometry(positions, normals, uvs, [], [], indices, !asWireframe);
    }

    public static Sphere(segments: number = 32, radius: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
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

                let pos = [x, y, z];
                let uv = [(segments - j) / segments, v];
                let nor = vec3.normalize(vec3.create(), vec3.fromValues(x,y,z));

                positions.push([pos[0], pos[1], pos[2]]);
                uvs.push([uv[0], uv[1]]);
                normals.push([nor[0], nor[1], nor[2]]);
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

    public static Cylinder(segments: number = 32, radius: number = 1, height: number = 1): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const indices: number[] = [];
    
        const halfHeight = height / 2;
    
        // side vertices
        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * 2 * Math.PI;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);
    
            for (let j = 0; j <= 1; j++) {
                const sign = j === 0 ? -1 : 1; // Switch between top and bottom
                const x = cosTheta * radius;
                const y = sign * halfHeight;
                const z = sinTheta * radius;
    
                const u = i / segments;
                const v = (1 + sign) / 2; // Map top to 1 and bottom to 0
    
                const normal = vec3.normalize(vec3.create(), vec3.fromValues(x, 0, z));
    
                positions.push([x, y, z]);
                normals.push([normal[0], normal[1], normal[2]]);
                uvs.push([u, v]);
            }
        }
    
        // side indices
        for (let i = 0; i < segments; ++i) {
            for (let j = 0; j < 1; ++j) {
                const k1 = i * 2 + j;
                const k2 = k1 + 2;
    
                indices.push(k1);
                indices.push(k1 + 1);
                indices.push(k2);
    
                indices.push(k2);
                indices.push(k1 + 1);
                indices.push(k2 + 1);
            }
        }

        // top vertices
        const angle = 2 * Math.PI / segments;
        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const y = halfHeight;
            const z = radius * Math.sin(angle * i);

            positions.push([x, y, z]);
            normals.push([0.0, 1.0, 0.0]);
            uvs.push([0.5 + x / radius / 2, 0.5 + z / radius / 2]);
        }

        // top indices
        for (let i = 0; i < segments; i++) {
            indices.push(positions.length - 1);
            indices.push(positions.length - i - 2);
            indices.push(positions.length - i - 3);
        }

        // bottom vertices
        for (let i = 0; i <= segments; i++) {
            const x = radius * Math.cos(angle * i);
            const y = -halfHeight;
            const z = radius * Math.sin(angle * i);

            positions.push([x, y, z]);
            normals.push([0.0, -1.0, 0.0]);
            uvs.push([0.5 + x / radius / 2, 0.5 + z / radius / 2]);
        }

        // bottom indices
        for (let i = 0; i < segments; i++) {
            indices.push(positions.length - 1);
            indices.push(positions.length - i - 3);
            indices.push(positions.length - i - 2);
        }


        return new Geometry(positions, normals, uvs, [], [], indices);
    }

    public static async Terrain(heightmapPath: string): Promise<Geometry> {
        return new Promise<Geometry>((resolve, reject) => {
            const positions: [number, number, number][] = [];
            const normals: [number, number, number][] = [];
            const uvs: [number, number][] = [];
            const indices: number[] = [];

            Loader.ImageToArray(heightmapPath).then((image) => {
                const width = image.width;
                const height = image.height;
    
                const halfWidth = width / 2;
                const halfHeight = height / 2;
                let data = image.data;

                // calculate amplitude based on width and height of the image
                const amplitude = Math.sqrt(Math.max(width, height)) / 2;
    
                for (let i = 0; i <= width; i++) {
                    for (let j = 0; j <= height; j++) {
                        const x = -halfWidth + j;
                        const y = ((data[(i * height + j) * 4] / 255 ) * 2 - 1) * amplitude;
                        const z = halfHeight - i;
    
                        positions.push([x, y, z]);
                        uvs.push([j / height, i / width]);
                        // calculate normal
                        let normal = vec3.fromValues(0.0, 0.0, 0.0);
                        if (i > 0 && j > 0) {
                            const v1 = vec3.fromValues(positions[i * (height + 1) + j][0], positions[i * (height + 1) + j][1], positions[i * (height + 1) + j][2]);
                            const v2 = vec3.fromValues(positions[(i - 1) * (height + 1) + j][0], positions[(i - 1) * (height + 1) + j][1], positions[(i - 1) * (height + 1) + j][2]);
                            const v3 = vec3.fromValues(positions[i * (height + 1) + j - 1][0], positions[i * (height + 1) + j - 1][1], positions[i * (height + 1) + j - 1][2]);
                            const v4 = vec3.fromValues(positions[(i - 1) * (height + 1) + j - 1][0], positions[(i - 1) * (height + 1) + j - 1][1], positions[(i - 1) * (height + 1) + j - 1][2]);
                            const e1 = vec3.create();
                            const e2 = vec3.create();
                            const e3 = vec3.create();
                            const e4 = vec3.create();
                            vec3.sub(e1, v1, v2);
                            vec3.sub(e2, v1, v3);
                            vec3.sub(e3, v1, v4);
                            vec3.sub(e4, v2, v3);
                            const t1 = vec3.create();
                            const t2 = vec3.create();
                            const t3 = vec3.create();
                            const t4 = vec3.create();
                            vec3.cross(t1, e1, e2);
                            vec3.cross(t2, e1, e3);
                            vec3.cross(t3, e1, e4);
                            vec3.cross(t4, e2, e3);
                            vec3.add(normal, normal, t1);
                            vec3.add(normal, normal, t2);
                            vec3.add(normal, normal, t3);
                            vec3.add(normal, normal, t4);
                            vec3.normalize(normal, normal);
                            vec3.scale(normal, normal, -1.0);
                        }
                        normals.push([normal[0], normal[1], normal[2]]);
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
            ).catch((error) => {
                reject(error);
            });
        });
    }
}