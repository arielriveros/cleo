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
        const identifier = id || uuidv4();
        const texture = new Texture(config);
        this._textures.set(identifier, texture);
        Loader.loadImage(path).then((image: HTMLImageElement) => {
            texture.create(image, image.width, image.height);
        }).catch((err) => {
            // Missing/broken image path (e.g. a texture file not included in an import): drop the
            // texture rather than leaving the load promise to surface as an unhandled rejection.
            console.warn('Failed to load texture from path:', path, err);
            this._textures.delete(identifier);
        });
        return identifier;
    }

    public addTextureFromData(data: HTMLImageElement, config?: TextureConfig, id?: string): string {
        const texture = new Texture(config);
        texture.create(data, data.width, data.height);
        const identifier = id || uuidv4();
        return this.addTexture(texture, identifier);
    }

    public addTextureFromBase64(base64: string | undefined, config?: TextureConfig, id?: string): string | undefined {
        if (!base64) return undefined;
        
        console.log('Creating texture from base64 data:', base64.substring(0, 50) + '...');
        
        const identifier = id || uuidv4();
        const texture = new Texture(config);
        
        // Add the texture to the map immediately but don't create it yet
        this._textures.set(identifier, texture);
        
        const image = new Image();
        
        // Set up error handling first
        image.onerror = (err) => {
            console.error('Failed to load base64 image:', err);
            console.error('Base64 data prefix:', base64.substring(0, 100));
            
            // Try creating a fallback 1x1 white texture
            console.log('Creating fallback 1x1 white texture...');
            this.createFallbackTexture(texture, identifier);
        };
        
        image.onload = () => {
            console.log(`Base64 image loaded successfully: ${image.width}x${image.height}`);
            console.log('Image complete:', image.complete);
            console.log('Image naturalWidth:', image.naturalWidth);
            console.log('Image naturalHeight:', image.naturalHeight);
            
            if (image.width > 0 && image.height > 0 && image.complete) {
                // Now create the texture with the loaded image
                texture.create(image, image.width, image.height);
            } else {
                console.error('Invalid image dimensions or not complete:', image.width, image.height, image.complete);
                // Create fallback texture instead of removing
                this.createFallbackTexture(texture, identifier);
            }
        };
        
        // Set src after setting up event handlers
        image.src = base64;
        
        return identifier;
    }
    
    private createFallbackTexture(texture: Texture, identifier: string): void {
        try {
            // Create a 1x1 white pixel
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, 1, 1);
                
                const fallbackImage = new Image();
                fallbackImage.onload = () => {
                    console.log('Fallback texture created successfully');
                    texture.create(fallbackImage, 1, 1);
                };
                fallbackImage.src = canvas.toDataURL();
            }
        } catch (err) {
            console.error('Failed to create fallback texture:', err);
            this._textures.delete(identifier);
        }
    }

    public addTextureFromFile(file: File, config?: TextureConfig, id?: string): string | undefined {
        if (!file) return undefined;

        const identifier = id || uuidv4();
        const texture = new Texture(config);

        // Register the texture immediately so callers can use the id synchronously; the image loads async.
        this._textures.set(identifier, texture);

        // Read the file into a self-contained data URL rather than an object URL. Blob URLs created with
        // URL.createObjectURL have a revoke/lifetime that can 404 (net::ERR_FILE_NOT_FOUND) when the load
        // is deferred (e.g. an import re-parse after the review modal) or the source File's disk backing
        // goes stale; a data URL carries the bytes inline and has no such lifetime.
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => this._textures.delete(identifier);
            image.onload = () => {
                if (image.width > 0 && image.height > 0 && image.complete) {
                    texture.create(image, image.width, image.height);
                } else {
                    console.error('Invalid file image dimensions:', image.width, image.height);
                    this._textures.delete(identifier);
                }
            };
            image.src = reader.result as string;
        };
        reader.onerror = () => {
            console.warn('Failed to read texture file:', file.name);
            this._textures.delete(identifier);
        };
        reader.readAsDataURL(file);

        return identifier;
    }

    public getTexture(id: string): Texture {
        const texture = this._textures.get(id);
        if (!texture) return undefined;
        return texture;
    }

    public serializeTexture(id: string): string {
        const texture = this._textures.get(id);
        if (!texture) return undefined;
        // Data-backed textures (e.g. editable terrain splat maps) have no HTMLImageElement to draw;
        // skip them here — such subsystems serialize their own pixel data separately.
        if (!(texture.data instanceof HTMLImageElement)) return undefined;

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
            const data = this.serializeTexture(id);
            if (!data) return; // skip data-backed textures (no image to embed)
            textures.push({ id, data, config: texture.config });
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

    public get textures(): Map<string, Texture> {
        return this._textures;
    }
}