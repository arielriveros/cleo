import { Loader } from "../loader";
import { CubemapFaces, Texture, TextureConfig } from "../texture";
import { parseBase64DataUri } from "../../core/base64";
import { Logger } from "../../core/logger";
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

    /**
     * Register a texture and return the id it is stored under.
     * @param id Omit to generate one, in which case the return value is the only handle to it.
     */
    public addTexture(texture: Texture, id?: string): string {
        const identifier = id || uuidv4();
        this._textures.set(identifier, texture);
        return identifier;
    }

    public addTextureFromPath(path: string, config?: TextureConfig, id?: string): string {
        const identifier = id || uuidv4();
        const texture = new Texture(config);
        this._textures.set(identifier, texture);
        Loader.loadImage(path).then((image: HTMLImageElement) => {
            texture.create(image, image.width, image.height);
        }).catch((err) => {
            // Drop the texture rather than let the load promise surface as an unhandled rejection.
            Logger.print('warn', ['Failed to load texture from path:', path, err], 'Texture');
            this._textures.delete(identifier);
        });
        return identifier;
    }

    /**
     * Register an ALREADY-DECODED image, ready the instant this returns. Pass `source` whenever the
     * caller still holds the compressed bytes — without them the texture cannot be persisted.
     */
    public addTextureFromData(
        data: HTMLImageElement,
        config?: TextureConfig,
        id?: string,
        source?: { bytes: Uint8Array; mime: string },
    ): string {
        const texture = new Texture(config);
        texture.create(data, data.width, data.height);
        if (source) texture.setSource(source.bytes, source.mime);
        const identifier = id || uuidv4();
        return this.addTexture(texture, identifier);
    }

    /**
     * Create a texture from a `data:<mime>;base64,…` URI, decoded to bytes and routed through
     * {@link addTextureFromBytes} so it retains its source. Non-base64 URIs take the plain `<img>` path.
     */
    public addTextureFromBase64(base64: string | undefined, config?: TextureConfig, id?: string): string | undefined {
        if (!base64) return undefined;

        const parsed = parseBase64DataUri(base64);
        if (parsed) return this.addTextureFromBytes(parsed.bytes, parsed.mime, config, id);

        // Not a base64 data URI — decode it as an image source directly.
        const identifier = id || uuidv4();
        const texture = new Texture(config);
        this._textures.set(identifier, texture);

        const image = new Image();
        image.onerror = () => {
            Logger.error('Failed to load image from data URI', 'Texture');
            this.createFallbackTexture(texture, identifier);
        };
        image.onload = () => {
            if (image.width > 0 && image.height > 0 && image.complete)
                texture.create(image, image.width, image.height);
            else
                this.createFallbackTexture(texture, identifier);
        };
        image.src = base64;

        return identifier;
    }

    /** The compressed bytes a texture was decoded from, or null (built-ins and path-loaded images have none). */
    public getSource(id: string): { bytes: Uint8Array; mime: string } | null {
        return this._textures.get(id)?.source ?? null;
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
                    Logger.info('Fallback texture created successfully', 'Texture');
                    texture.create(fallbackImage, 1, 1);
                };
                fallbackImage.src = canvas.toDataURL();
            }
        } catch (err) {
            Logger.print('error', ['Failed to create fallback texture:', err], 'Texture');
            this._textures.delete(identifier);
        }
    }

    /**
     * Create a texture from compressed image bytes, decoded from a Blob URL and retained on the Texture
     * so serialization needs no canvas re-encode. Uploads an `HTMLImageElement`, never an `ImageBitmap`
     * — `UNPACK_FLIP_Y_WEBGL` is inconsistent with the latter and the flip is load-bearing.
     */
    public addTextureFromBytes(bytes: Uint8Array, mime: string, config?: TextureConfig, id?: string): string | undefined {
        if (!bytes || bytes.length === 0) return undefined;

        const identifier = id || uuidv4();
        const texture = new Texture(config);

        // Register immediately so callers get a usable id synchronously; the image decodes async.
        this._textures.set(identifier, texture);
        this._decodeInto(texture, identifier, bytes, mime);

        return identifier;
    }

    /** Decode compressed bytes into an already-registered texture, retaining them for serialization. */
    private _decodeInto(texture: Texture, identifier: string, bytes: Uint8Array, mime: string): void {
        texture.setSource(bytes, mime);

        // Cast: a Uint8Array is a valid BlobPart at runtime, but lib.dom's type is narrower.
        const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
        const url = URL.createObjectURL(blob);
        // The URL must live for the texture's lifetime: the asset explorer previews cards straight off
        // `texture.data.src`, so revoking on load breaks every one of them.
        texture.setObjectUrl(url);

        const drop = (reason: string) => {
            Logger.warn(reason, 'Texture');
            texture.revokeObjectUrl();
            this._textures.delete(identifier);
        };

        const image = new Image();
        image.onload = () => {
            if (image.width > 0 && image.height > 0) texture.create(image, image.width, image.height);
            else drop(`Invalid image dimensions from bytes: ${image.width}x${image.height}`);
        };
        image.onerror = () => drop('Failed to decode texture bytes');
        image.src = url;
    }

    public addTextureFromFile(file: File, config?: TextureConfig, id?: string): string | undefined {
        if (!file) return undefined;

        const identifier = id || uuidv4();
        const texture = new Texture(config);

        // Register SYNCHRONOUSLY: `awaitTexturesReady` reads an unknown id as "nothing to wait for", so
        // a late registration lets an import serialize before the texture has decoded.
        this._textures.set(identifier, texture);

        file.arrayBuffer()
            .then(buf => this._decodeInto(texture, identifier, new Uint8Array(buf), file.type || 'image/png'))
            .catch(() => {
                Logger.print('warn', ['Failed to read texture file:', file.name], 'Texture');
                this._textures.delete(identifier);
            });

        return identifier;
    }

    /** The texture registered under `id`, or undefined. Absent ids are routine — entries drop on failure. */
    public getTexture(id: string): Texture | undefined {
        return this._textures.get(id);
    }

    /**
     * A texture as a self-contained data URL, or undefined when it has no image to embed. Retained
     * source bytes are re-wrapped directly; only a path-loaded image pays the canvas re-encode.
     */
    public serializeTexture(id: string): string | undefined {
        const texture = this._textures.get(id);
        if (!texture) return undefined;

        // 1. Created from bytes: re-wrap the ORIGINAL compressed bytes, which keeps a JPEG a JPEG.
        const source = texture.sourceUri;
        if (source) return source;

        // Data-backed textures have no image to draw; those subsystems serialize their own pixels.
        if (!(texture.data instanceof HTMLImageElement)) return undefined;

        // 2. Created from a data URL (an asset restored from storage): reuse it verbatim.
        const image = texture.data as HTMLImageElement;
        if (image.src && image.src.startsWith('data:')) return image.src;

        // 3. Path-loaded image (an http/relative src, no bytes retained): re-encode through a canvas.
        const canvas = document.createElement('canvas');
        canvas.width = texture.width;
        canvas.height = texture.height;
        const ctx = canvas.getContext('2d');
        // Only null under context loss or OOM; every caller reads undefined as "nothing to embed".
        if (!ctx) return undefined;
        ctx.drawImage(image, 0, 0);

        return canvas.toDataURL('image/png', 1.0);
    }

    /**
     * Snapshot textures as `{ id, data, config }` records. Pass `ids` for a subset — a caller that needs
     * a handful must, since filtering a whole-project snapshot afterwards is the editor's worst stall.
     */
    public serializeTextureData(ids?: Iterable<string>): any {
        const textures: {id: string, data: string, config: any}[] = [];

        if (ids) {
            for (const id of ids) {
                const texture = this._textures.get(id);
                if (!texture) continue;
                const data = this.serializeTexture(id);
                if (!data) continue; // skip data-backed textures (no image to embed)
                textures.push({ id, data, config: texture.config });
            }
            return textures;
        }

        this._textures.forEach((texture, id) => {
            const data = this.serializeTexture(id);
            if (!data) return; // skip data-backed textures (no image to embed)
            textures.push({ id, data, config: texture.config });
        });
        return textures;
    }

    /**
     * Snapshot textures as raw compressed bytes — the binary twin of {@link serializeTextureData}, for
     * consumers writing binary rather than JSON. Path-loaded images fall back through the canvas path.
     */
    public serializeTextureBytes(ids?: Iterable<string>): { id: string, bytes: Uint8Array, mime: string, config: any }[] {
        const out: { id: string, bytes: Uint8Array, mime: string, config: any }[] = [];

        const collect = (id: string, texture: Texture): void => {
            // 1. The common case: original compressed bytes, already on the Texture. No work at all.
            const source = texture.source;
            if (source) {
                out.push({ id, bytes: source.bytes, mime: source.mime, config: texture.config });
                return;
            }

            // 2. No retained bytes: go through the data-URL path and decode back. Costs a canvas encode.
            const uri = this.serializeTexture(id);
            if (!uri) return; // data-backed texture, or no 2D context — nothing to embed
            const parsed = parseBase64DataUri(uri);
            if (!parsed) return;
            out.push({ id, bytes: parsed.bytes, mime: parsed.mime, config: texture.config });
        };

        if (ids) {
            for (const id of ids) {
                const texture = this._textures.get(id);
                if (texture) collect(id, texture);
            }
            return out;
        }

        this._textures.forEach((texture, id) => collect(id, texture));
        return out;
    }

    /** The six faces as data URLs, or undefined if a 2D canvas context cannot be obtained. */
    public serializeCubeMap(texture: Texture): {
        positiveX: string,
        negativeX: string,
        positiveY: string,
        negativeY: string,
        positiveZ: string,
        negativeZ: string
    } | undefined {
        const base64Images = [];

        const canvas = document.createElement('canvas');
        // Null only under context loss or OOM — bail rather than throw.
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;

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
        // Release the blob: URL only. The GPU texture is left alone — other holders may still draw it.
        this._textures.get(id)?.revokeObjectUrl();
        this._textures.delete(id);
    }

    public get textures(): Map<string, Texture> {
        return this._textures;
    }
}