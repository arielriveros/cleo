import { Loader } from "../loader";
import { CubemapFaces, Texture, TextureConfig } from "../texture";
import { v4 as uuidv4 } from 'uuid';

export class TextureManager {
    private static _instance: TextureManager | null = null;
    private _textures: Map<string, Texture>;

    private constructor() {
        this._textures = new Map<string, Texture>();
    }

    public static get Instance(): TextureManager {
        if (!TextureManager._instance)
            TextureManager._instance = new TextureManager();
        return TextureManager._instance;
    }

    public addTexture(texture: Texture, id?: string): string {
        const identifier = id || uuidv4();
        this._textures.set(identifier, texture);
        return id;
    }

    public addTextureFromPath(path: string, config?: TextureConfig, id?: string): string {
        const texture = new Texture(config);
        Loader.loadImage(path).then(image => {
            texture.create(image, image.width, image.height);
        });
        const identifier = id || uuidv4();
        return this.addTexture(texture, identifier);
    }

    public addTextureFromData(data: HTMLImageElement, config?: TextureConfig, id?: string): string {
        const texture = new Texture(config);
        texture.create(data, data.width, data.height);
        const identifier = id || uuidv4();
        return this.addTexture(texture, identifier);
    }

    public addTextureFromBase64(base64: string | undefined, config?: TextureConfig, id?: string): string {
        const texture = new Texture(config);
        const image = new Image()
        image.src = base64;
        image.onload = () => texture.create(image, image.width, image.height);
        const identifier = id || uuidv4();
        return this.addTexture(texture, identifier);
    }

    public getTexture(id: string): Texture {
        const texture = this._textures.get(id);
        if (!texture) return undefined;
        return texture;
    }

    public serializeTexture(id: string): string {
        const texture = this._textures.get(id);
        if (!texture) return undefined;
        
        const canvas = document.createElement('canvas');
        canvas.width = texture.width;
        canvas.height = texture.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(texture.data as HTMLImageElement, 0, 0);

        return canvas.toDataURL('image/png', 1.0);
    }

    public serializeTextureData(): any {
        const textures: {id: string, data: string, config: any}[] = []; // Define index signature for textures object
        this._textures.forEach((texture, id) => {
            textures.push({
                id, data: this.serializeTexture(id), config: texture.config
            });
        });
        return textures;
    }

    public serializeCubeMap(texture: Texture): {
        positiveX: string,
        negativeX: string,
        positiveY: string,
        negativeY: string,
        positiveZ: string,
        negativeZ: string
    } {
        if (!texture) return undefined;

        const base64Images = [];

        const canvas = document.createElement('canvas');
        const data = texture.data as CubemapFaces;
        const images = [
            data.posX,
            data.negX,
            data.posY,
            data.negY,
            data.posZ,
            data.negZ
        ];

        for (let i = 0; i < images.length; i++) {
            canvas.width = images[i].width;
            canvas.height = images[i].height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(images[i], 0, 0);
            base64Images.push(canvas.toDataURL('image/png', 1.0));
        }
        
        return {
            positiveX: base64Images[0],
            negativeX: base64Images[1],
            positiveY: base64Images[2],
            negativeY: base64Images[3],
            positiveZ: base64Images[4],
            negativeZ: base64Images[5]
        }
    }

    public removeTexture(id: string): void {
        this._textures.delete(id);
    }
}