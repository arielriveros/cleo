import { vec2, vec3 } from "gl-matrix";
import { Geometry } from "../core/geometry";
import { OBJ } from "webgl-obj-loader";

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
        return request.responseText;
    }

    public static loadOBJ(path: string): Promise<Geometry> {
        const objRaw = Loader.loadText(path);
        return new Promise<Geometry>((resolve, reject) => {

            const obj = new OBJ.Mesh(objRaw);
            const positions: vec3[] = [];
            for (let i = 0; i < obj.vertices.length; i += 3) {
                positions.push(vec3.fromValues(obj.vertices[i], obj.vertices[i + 1], obj.vertices[i + 2]));
            }

            const normals: vec3[] = [];
            for (let i = 0; i < obj.vertexNormals.length; i += 3) {
                normals.push(vec3.fromValues(obj.vertexNormals[i], obj.vertexNormals[i + 1], obj.vertexNormals[i + 2]));
            }

            const uvs: vec2[] = [];
            for (let i = 0; i < obj.textures.length; i += 2) {
                uvs.push(vec2.fromValues(obj.textures[i], obj.textures[i + 1]));
            }

            const indices = obj.indices

            const geometry = new Geometry(positions, normals, uvs, indices);
            resolve(geometry);
        });
    }

}