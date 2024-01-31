import { Mesh } from './mesh';
import { Geometry } from '../core/geometry';
import { Loader } from './loader';
import { CubemapFaces, Texture } from './texture';
import { TextureManager } from '../cleo';

export class Skybox {
    private readonly _boxMesh: Mesh = new Mesh();
    private readonly _skyboxTexture: Texture;
    private readonly _geometry: Geometry = Geometry.Cube();

    constructor(cubemapFaces: CubemapFaces | null) {
        this._skyboxTexture = new Texture({ target: 'cubemap', flipY: true });
        if (cubemapFaces)
            this._skyboxTexture.create(cubemapFaces, cubemapFaces.posX?.width, cubemapFaces.posX?.height);
        else
            this._skyboxTexture.create(null, 0, 0);
    }

    public static fromFiles(files: {posX: string, negX: string, posY: string, negY: string, posZ: string, negZ: string}): Promise<Skybox> {
        return new Promise((resolve, reject) => {
            const promises = [
                Loader.loadImage(files.posX),
                Loader.loadImage(files.negX),
                Loader.loadImage(files.posY),
                Loader.loadImage(files.negY),
                Loader.loadImage(files.posZ),
                Loader.loadImage(files.negZ)
            ];
            Promise.all(promises).then((images) => {
                const cubemapFaces: CubemapFaces = {
                    posX: images[0],
                    negX: images[1],
                    posY: images[2],
                    negY: images[3],
                    posZ: images[4],
                    negZ: images[5]
                };
                resolve(new Skybox(cubemapFaces));
            });
        });
    }
    
    public static fromBase64(base64: {posX: string, negX: string, posY: string, negY: string, posZ: string, negZ: string}): Promise<Skybox> {
        const createImage = (base64: string): Promise<HTMLImageElement> => {
            return new Promise((resolve, reject) => {
                const image = new Image();
                image.src = base64;
                image.onload = () => resolve(image);
            });
        }
        return new Promise((resolve, reject) => {
            const promises = [
                createImage(base64.posX),
                createImage(base64.negX),
                createImage(base64.posY),
                createImage(base64.negY),
                createImage(base64.posZ),
                createImage(base64.negZ)
            ];
            Promise.all(promises).then((images) => {
                const cubemapFaces: CubemapFaces = {
                    posX: images[0],
                    negX: images[1],
                    posY: images[2],
                    negY: images[3],
                    posZ: images[4],
                    negZ: images[5]
                };
                resolve(new Skybox(cubemapFaces));
            });
        });
    }

    public serialize(): any {
        const faces = TextureManager.Instance.serializeCubeMap(this._skyboxTexture);
        return { faces: faces };
    }

    public get mesh(): Mesh {
        return this._boxMesh;
    }

    public get texture(): Texture {
        return this._skyboxTexture;
    }

    public get box(): Geometry {
        return this._geometry;
    }

}