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
     * Registers a texture and returns the id it is stored under.
     *
     * @param id Optional id to store under. Omit to have one generated — in which case the returned id is
     *           the ONLY handle to the texture, since nothing else knows the generated value.
     */
    public addTexture(texture: Texture, id?: string): string {
        const identifier = id || uuidv4();
        this._textures.set(identifier, texture);
        // `identifier`, not `id`: called without an id this used to return undefined, storing the texture
        // under a generated uuid that the caller could then never look up.
        return identifier;
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
            Logger.print('warn', ['Failed to load texture from path:', path, err], 'Texture');
            this._textures.delete(identifier);
        });
        return identifier;
    }

    /**
     * Register an ALREADY-DECODED image. Unlike the base64/bytes paths this is ready the instant it
     * returns, which is what anything reading the image's pixel dimensions needs.
     *
     * Pass `source` whenever the caller still has the file's compressed bytes. Without them
     * `getSource` returns null, and anything that persists or re-shares textures by their original
     * bytes — the editor's texture store, asset-pack export — skips the texture silently, so the image
     * is simply gone after a reload.
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
     * Create a texture from a `data:<mime>;base64,…` URI.
     *
     * Base64 data URIs are decoded to bytes here and go through the shared bytes path, rather than being
     * handed to `image.src` verbatim. That means:
     *  - the browser never has to base64-decode a multi-megabyte string just to start decoding the image
     *    (restoring a saved project used to do exactly that, once per texture);
     *  - EVERY texture ends up retaining its compressed source bytes, which is what lets textures be stored
     *    and shared as Blobs instead of being re-embedded as base64 in every asset that references them.
     *
     * Anything that isn't base64 (e.g. `data:image/svg+xml,<raw>`) still goes down the plain <img> path.
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
     * Create a texture from compressed image bytes (PNG/JPEG/…) — the fast path used by import.
     *
     * The bytes are handed to the browser as a Blob and decoded from an object URL. Nothing goes through
     * base64: the glTF loader used to hand-roll a data URL byte by byte, which the browser then had to
     * base64-DECODE again before it could even start decoding the image. Both halves of that are gone.
     *
     * The bytes are retained on the Texture (see Texture.setSource) so serialization can still produce a
     * data URL later, on demand, without re-encoding the decoded pixels through a canvas.
     *
     * An HTMLImageElement (not createImageBitmap) is still what gets uploaded: UNPACK_FLIP_Y_WEBGL behaves
     * inconsistently with ImageBitmap across browsers, and the flip semantics here are load-bearing.
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

        // Cast: a Uint8Array IS a valid BlobPart at runtime, but lib.dom types BlobPart against
        // ArrayBufferView<ArrayBuffer> and a plain Uint8Array widens to Uint8Array<ArrayBufferLike>.
        const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
        const url = URL.createObjectURL(blob);
        // The URL stays alive for the texture's lifetime (revoked in Texture.delete). It cannot be revoked
        // on load: the asset explorer previews a texture card straight off `texture.data.src`, so an early
        // revoke would leave every texture card showing a broken image.
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

        // Register synchronously — callers use the id right away, and awaitTexturesReady treats an
        // unknown id as "nothing to wait for", so a texture that only appeared later would let an import
        // serialize before it had decoded and produce an untextured asset.
        this._textures.set(identifier, texture);

        // Then decode from the raw bytes. The old path ran the whole file through
        // FileReader.readAsDataURL, base64-ing it only for the browser to decode it straight back.
        file.arrayBuffer()
            .then(buf => this._decodeInto(texture, identifier, new Uint8Array(buf), file.type || 'image/png'))
            .catch(() => {
                Logger.print('warn', ['Failed to read texture file:', file.name], 'Texture');
                this._textures.delete(identifier);
            });

        return identifier;
    }

    /**
     * The texture registered under `id`, or undefined if there is none.
     *
     * Genuinely absent ids are routine, not exceptional: entries are dropped on every failure path (a
     * 404ing source, a decode failure, `removeTexture`), so an id held elsewhere can go stale at any time.
     */
    public getTexture(id: string): Texture | undefined {
        return this._textures.get(id);
    }

    /**
     * A texture as a self-contained data URL, or undefined if it has no image to embed.
     *
     * Textures created from base64 or from an uploaded File already HAVE a data URL as their image's
     * `src` (see addTextureFromBase64 / addTextureFromFile) — so the common case is a string return with
     * no work at all. Re-encoding those through a canvas was pure waste: it cost a full PNG encode
     * (tens to hundreds of ms per texture) and inflated JPEGs several-fold by re-encoding them as PNG.
     * The canvas path remains only for path-loaded images, whose `src` is an http/relative URL.
     */
    public serializeTexture(id: string): string | undefined {
        const texture = this._textures.get(id);
        if (!texture) return undefined;

        // 1. Created from bytes (import): re-wrap the ORIGINAL compressed bytes. Encoded on first call and
        //    memoized on the Texture, so importing never pays for base64 — only saving does. This also
        //    keeps a JPEG a JPEG, instead of the canvas path's several-times-larger PNG.
        const source = texture.sourceUri;
        if (source) return source;

        // Data-backed textures (e.g. editable terrain splat maps) have no HTMLImageElement to draw;
        // skip them here — such subsystems serialize their own pixel data separately.
        if (!(texture.data instanceof HTMLImageElement)) return undefined;

        // 2. Created from a data URL (an asset restored from storage): reuse it verbatim.
        const image = texture.data as HTMLImageElement;
        if (image.src && image.src.startsWith('data:')) return image.src;

        // 3. Path-loaded image (an http/relative src, no bytes retained): re-encode through a canvas.
        const canvas = document.createElement('canvas');
        canvas.width = texture.width;
        canvas.height = texture.height;
        const ctx = canvas.getContext('2d');
        // Only null under context loss / OOM, but that is exactly when a thrown TypeError would be least
        // welcome. Bailing matches createFallbackTexture's handling of the same call, and every caller
        // already treats an absent result as "nothing to embed".
        if (!ctx) return undefined;
        ctx.drawImage(image, 0, 0);

        return canvas.toDataURL('image/png', 1.0);
    }

    /**
     * Snapshot textures as `{ id, data, config }` records.
     *
     * Pass `ids` to snapshot only those textures. Callers that need a handful (an imported material
     * embedding its own maps) must do this: walking every texture in the project and filtering afterwards
     * is O(all textures) per call, and with the canvas fallback it was the single worst stall in the
     * editor. Omit `ids` for a whole-project snapshot (scene serialize, save, publish).
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
     * Snapshot textures as raw compressed bytes — `{ id, bytes, mime, config }` records.
     *
     * The bytes-oriented twin of {@link serializeTextureData}, for consumers that write binary rather
     * than JSON (publishing packs them into game.bin). For every imported texture this is strictly
     * cheaper than the base64 path AND smaller on disk: `Texture.source` already retains the original
     * compressed PNG/JPEG bytes, so there is nothing to encode and no 33% base64 inflation to pay.
     *
     * Path-loaded images have no retained bytes, so they fall back through serializeTexture's canvas
     * re-encode and are decoded straight back to bytes. Data-backed textures (terrain splat maps) have
     * no image to embed and are skipped, exactly as in serializeTextureData.
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

            // 2. No retained bytes (path-loaded, or restored from a non-base64 data URI): go through the
            //    data-URL path and decode it back. Costs a canvas encode, same as saving does today.
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
        // Hoisted: it is the same canvas every iteration, so this was six identical getContext calls.
        // Null only under context loss / OOM — bail rather than throw, as serializeTexture does.
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
        // Release the blob: URL an imported texture is decoded from. The GL texture is deliberately left
        // alone — this only drops the registry entry, and other holders may still be drawing with it.
        this._textures.get(id)?.revokeObjectUrl();
        this._textures.delete(id);
    }

    public get textures(): Map<string, Texture> {
        return this._textures;
    }
}