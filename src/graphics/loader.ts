import { vec2, vec3 } from "gl-matrix";
import { Geometry } from "../core/geometry";
import { Material } from "./material";
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

    public static async loadFromFile(filePaths: string[]): Promise<{name: string, geometry: Geometry, material: Material}[]> {
        const output: {name: string, geometry: Geometry, material: Material}[] = [];

        const res = await loadAssimpModel(filePaths);
        const materials = [];
        for (const mat of res.materials)
            materials.push(parseMaterial(mat, filePaths[0]?.split('/').slice(0, -1).join('/')));

        const meshes:{
            name: any;
            positions: ([number, number, number] | Float32Array)[];
            normals: ([number, number, number] | Float32Array)[];
            tangents: ([number, number, number] | Float32Array)[];
            bitangents: ([number, number, number] | Float32Array)[];
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

            const tangents: number[] = m.tangents;
            const bitangents: number[] = m.bitangents;

            const positions = [];
            for (let i = 0; i < vertices.length; i += 3)
                positions.push(vec3.fromValues(vertices[i], vertices[i + 1], vertices[i + 2]));

            const normalsVec = [];
            for (let i = 0; i < normals.length; i += 3)
                normalsVec.push(vec3.fromValues(normals[i], normals[i + 1], normals[i + 2]));

            const uvsVec = [];
            for (let i = 0; i < uvs.length; i += 2)
                uvsVec.push(vec2.fromValues(uvs[i], uvs[i + 1]));

            const tangentsVec = [];
            for (let i = 0; i < tangents.length; i += 3)
                tangentsVec.push(vec3.fromValues(tangents[i], tangents[i + 1], tangents[i + 2]));

            const bitangentsVec = [];
            for (let i = 0; i < bitangents.length; i += 3)
                bitangentsVec.push(vec3.fromValues(bitangents[i], bitangents[i + 1], bitangents[i + 2]));

            meshes.push({name,
                         positions,
                         normals: normalsVec,
                         uvs: uvsVec,
                         tangents: tangentsVec, 
                         bitangents: bitangentsVec,
                         indices, materialindex: m.materialindex});
        }

        for (const mesh of meshes) {
            const geometry = new Geometry(mesh.positions, mesh.normals, mesh.uvs, mesh.tangents, mesh.bitangents, mesh.indices);
            const matIndex = mesh.materialindex;
            const material = materials[matIndex].material;
            output.push({name: mesh.name, geometry, material});
        }

        return output;
    }
}