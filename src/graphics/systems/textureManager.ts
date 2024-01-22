import { Loader } from "../loader";
import { Texture, TextureConfig } from "../texture";
import { v4 as uuidv4 } from 'uuid';

export class TextureManager {
    private static _instance: TextureManager | null = null;
    private _isLoading: boolean;
    private _textures: Map<string, Texture>;

    private constructor() {
        this._textures = new Map<string, Texture>();
        this._isLoading = false;
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
        this._isLoading = true;
        const texture = new Texture(config);
        Loader.loadImage(path).then(image => {
            texture.create(image, image.width, image.height);
            this._isLoading = false;
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
        ctx.drawImage(texture.data, 0, 0);

        return canvas.toDataURL('image/png', 1.0);
    }

    public removeTexture(id: string): void {
        this._textures.delete(id);
    }
}