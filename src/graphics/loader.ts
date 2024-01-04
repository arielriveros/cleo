import { vec2, vec3 } from "gl-matrix";
import { Geometry } from "../core/geometry";
import { OBJ } from "webgl-obj-loader";
import { Material } from "../core/material";
import { Texture } from "./texture";
import { loadAssimpModel, parseMaterial } from "./utils/assimpLoader";

export class Loader {
    public static async loadImage(path: string): Promise<HTMLImageElement> {
        return new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.src = path;
            image.onload = () => resolve(image);
            image.onerror = () => reject();
        });
    }

    public static loadText(path: string): string {
        const request = new XMLHttpRequest();
        request.open('GET', path, false);
        request.send(null);
        if (request.status !== 200) {
            throw new Error(`Failed to load file: ${path}`);
        }
        return request.responseText;
    }

    public static joinMeshes(meshes: {
        name: any,
        positions: ([number, number, number] | Float32Array)[],
        normals: ([number, number, number] | Float32Array)[],
        uvs: (Float32Array | [number, number])[],
        indices: number[],
        materialindex: any
    }[]) {
        const output: {
            name: any,
            positions: ([number, number, number] | Float32Array)[],
            normals: ([number, number, number] | Float32Array)[],
            uvs: (Float32Array | [number, number])[],
            indices: number[],
            materialindex: any
        } = {
            name: '',
            positions: [],
            normals: [],
            uvs: [],
            indices: [],
            materialindex: 0
        };

        for (const mesh of meshes) {
            const offset = output.positions.length;

            output.name = mesh.name;
            output.positions.push(...mesh.positions);
            output.normals.push(...mesh.normals);
            output.uvs.push(...mesh.uvs);
            output.indices.push(...mesh.indices.map((i) => i + offset));
            output.materialindex = mesh.materialindex;
        }

        return output;
    }

    public static async loadFromFile(filePaths: string[]): Promise<{name: string, geometry: Geometry, material: Material}[]> {
        const output: {name: string, geometry: Geometry, material: Material}[] = [];

        const res = await loadAssimpModel(filePaths);
        const materials = [];
        for (const mat of res.materials)
            materials.push(parseMaterial(mat, filePaths[0]?.split('/').slice(0, -1).join('/')));

        const rawMeshes:{
            name: any;
            positions: ([number, number, number] | Float32Array)[];
            normals: ([number, number, number] | Float32Array)[];
            uvs: (Float32Array | [number, number])[];
            indices: number[];
            materialindex: any;
        }[] = []
        for (const m of res.meshes) {
            const name = m.name;
            const vertices: number[] = m.vertices;
            const normals: number[] = m.normals;
            if (!normals) throw new Error(`Mesh ${name} has no normals`);
            const uvs: number[] = m.texturecoords[0];
            if (!uvs) throw new Error(`Mesh ${name} has no UVs`);
            const indices: number[] = m.faces.flat();

            const positions = [];
            for (let i = 0; i < vertices.length; i += 3)
                positions.push(vec3.fromValues(vertices[i], vertices[i + 1], vertices[i + 2]));

            const normalsVec = [];
            for (let i = 0; i < normals.length; i += 3)
                normalsVec.push(vec3.fromValues(normals[i], normals[i + 1], normals[i + 2]));

            const uvsVec = [];
            for (let i = 0; i < uvs.length; i += 2)
                uvsVec.push(vec2.fromValues(uvs[i], uvs[i + 1]));

            rawMeshes.push({name, positions, normals: normalsVec, uvs: uvsVec, indices, materialindex: m.materialindex});
        }

        const joinedMeshes = [];
        // join by same materialIndex
        for (let i = 0; i < materials.length; i++) {
            const meshes = rawMeshes.filter((m) => m.materialindex === i);
            if (meshes.length > 0)
                joinedMeshes.push(Loader.joinMeshes(meshes));
        }

        for (const mesh of joinedMeshes) {
            const geometry = new Geometry(mesh.positions, mesh.normals, mesh.uvs, mesh.indices);
            const matIndex = mesh.materialindex;
            const material = materials[matIndex].material;
            output.push({name: mesh.name, geometry, material});
        }

        return output;
    }

    public static loadMTL(mtlPath: string): {name: string, material: Material}[] {
            const materials: {name: string, material: Material}[] = [];
            const mtlRaw = Loader.loadText(mtlPath);
            const mtl = new OBJ.MaterialLibrary(mtlRaw);
            for (let mat in mtl.materials) {
                const name = mat;
                const materialData = mtl.materials[mat];

                const diffuse = materialData.diffuse;
                const specular = materialData.specular;
                const ambient = materialData.ambient;
                const shininess = materialData.specularExponent;
                const emissive = materialData.emissive;

                let opacity = 1.0;
                let transparent = false;
                if (materialData.transparency > 0.0) {
                    opacity = 1.0 - materialData.transparency;
                    transparent = true;
                }

                const path = mtlPath.split('/').slice(0, -1).join('/');
                const diffuseMap = materialData.mapDiffuse.filename !== '' ? `${path}/${materialData.mapDiffuse.filename}` : undefined
                const specularMap = materialData.mapSpecular.filename !== '' ? `${path}/${materialData.mapSpecular.filename}` : undefined;
                const emissiveMap = materialData.mapEmissive.filename !== '' ? `${path}/${materialData.mapEmissive.filename}` : undefined;

                const material = Material.Default({
                    ambient, diffuse, specular, shininess, emissive, opacity,
                    textures: {
                        base: diffuseMap ? new Texture().createFromFile(diffuseMap, {repeat: true}) : undefined,
                        specular: specularMap ? new Texture().createFromFile(specularMap, {repeat: true}) : undefined,
                        emissive: emissiveMap ? new Texture().createFromFile(emissiveMap, {repeat: true}) : undefined
                    }},
                    { transparent }
                );

                materials.push({name, material});
            }

            return materials;
    }
}