import { Texture, TextureConfig } from "../texture";
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

    public addTexture(texture: Texture): string {
        const id = uuidv4();
        this._textures.set(id, texture);
        return id;
    }

    public addTextureWithId(id: string, texture: Texture): void {
        if (this._textures.has(id)) throw new Error(`Texture ${id} already exists`);
        this._textures.set(id, texture);
    }

    public getTexture(id: string): Texture {
        const texture = this._textures.get(id);
        if (!texture) return undefined;
        return texture;
    }

    public removeTexture(id: string): void {
        this._textures.delete(id);
    }

    public addTextureFromPath(path: string, config?: TextureConfig): string {
        const texture = new Texture(config);
        const image = new Image();
        image.src = path;
        image.onload = () => {
            const data = new Uint8Array(image.width * image.height * 4);
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Failed to create canvas context');
            context.drawImage(image, 0, 0);
            const imageData = context.getImageData(0, 0, image.width, image.height);
            data.set(imageData.data);
            texture.create(data, image.width, image.height);
        };
        return this.addTexture(texture);
    }

    public addTextureFromPathWithId(id: string, path: string, config?: TextureConfig): void {
        const texture = new Texture(config);
        const image = new Image();
        image.src = path;
        image.onload = () => {
            const data = new Uint8Array(image.width * image.height * 4);
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Failed to create canvas context');
            context.drawImage(image, 0, 0);
            const imageData = context.getImageData(0, 0, image.width, image.height);
            data.set(imageData.data);
            texture.create(data, image.width, image.height);
        };
        this.addTextureWithId(id, texture);
    }

}