import { gl } from "../glContext";
import { device } from '../rhi/webgl2/webgl2Device';
import type { WebGL2Framebuffer } from '../rhi/webgl2/webgl2Device';
import { Texture } from "../texture";
import { Shader } from "../shader";
import { Mesh } from "../mesh";
import { GLState } from "./glState";
import { ShaderManager } from "./shaderManager";
import { TextureManager } from "./textureManager";
import { setViewportSize } from "../renderStats";
import { Logger } from "../../core/logger";
import { cyrb53 } from "../material";
import ScreenVertex from '../shaders/screen/screen.vs';
import ChannelPackFragment from '../shaders/screen/channelPack.fs';
import type { Material } from "../material";

// -------------------------------------------------------------------------------------------------
// Channel packing.
//
// Artists author metallic, roughness and occlusion as SEPARATE grayscale maps, because that is what
// texturing tools export. Shaders want the opposite: one texture, one fetch, one bound unit, three
// channels. This module is the seam between the two — it bakes the authored source maps into a single
// packed texture on the GPU and hands the material a derived slot to bind.
//
// The packed layout is glTF's ORM (r = occlusion, g = roughness, b = metallic), which is what
// geometryPBR.fs/pbr.fs already read and what every glTF import already delivers. That is not a
// cosmetic choice: it means an imported pre-packed map hits the identity fast path below and is reused
// byte-for-byte, with no bake, no cache entry and no extra VRAM.
//
// What this buys: fewer texture fetches, fewer binds, and freed texture units (standard materials give
// back unit 5, terrain goes from 13 units to 9). What it does NOT buy is memory — the packed texture is
// allocated IN ADDITION to its sources, which stay resident because the editor previews them.
// -------------------------------------------------------------------------------------------------

/** One destination channel: a channel of a source texture, or a constant. */
export type ChannelSource =
    | { textureId: string; channel: 0 | 1 | 2 | 3 }
    /**
     * `ignored` marks a constant the consuming shader will never read (its `has*` flag is false). Such
     * a channel does not have to be reproduced faithfully, which is exactly what lets a spec that is
     * otherwise a straight copy of one texture take the identity path.
     */
    | { constant: number; ignored?: boolean };

/** The four destination channels of a packed texture. */
export interface PackSpec {
    r: ChannelSource;
    g: ChannelSource;
    b: ChannelSource;
    a: ChannelSource;
}

/** Prefix on every packer-owned texture id. Derived textures are never authored, serialized or listed. */
export const PACKED_ID_PREFIX = '__packed__';

/** Whether `id` names a packer-derived texture rather than an authored source map. */
export function isDerivedTextureId(id: string | undefined | null): boolean {
    return !!id && id.startsWith(PACKED_ID_PREFIX);
}

interface CacheEntry {
    id: string;
    texture: Texture;
    lastFrame: number;
}

interface Binding {
    key: string;
    slot: string;
}

export class TexturePacker {
    private static _instance: TexturePacker | null = null;

    /** Packed textures older than this many frames without a user are collected. ~20s at 60fps. */
    private static readonly SWEEP_INTERVAL = 1200;
    /** Sources larger than this are downsampled into the pack rather than allocating past the GL limit. */
    private static readonly MAX_SIZE = 4096;

    private _cache: Map<string, CacheEntry> = new Map();
    /**
     * The spec each material is currently bound to, so a per-frame `sync` is a string compare rather
     * than a re-resolve. Weak because materials are replaced wholesale (the inspector's shader-type
     * switch, setNodeMaterial) and never disposed — there is no hook to unregister from.
     */
    private _bindings: WeakMap<Material, Binding> = new WeakMap();

    private _fbo: WebGL2Framebuffer | null = null;
    private _quad: Mesh | null = null;
    private _placeholder: string | null = null;
    private _lastSweep: number = 0;

    private constructor() {}

    public static get Instance(): TexturePacker {
        if (!TexturePacker._instance) TexturePacker._instance = new TexturePacker();
        return TexturePacker._instance;
    }

    // ---------------------------------------------------------------------------------------------
    // Material-facing entry point
    // ---------------------------------------------------------------------------------------------

    /**
     * Bring `material`'s derived texture slots in line with its authored source slots. Idempotent and
     * cheap enough to call every frame for every material: the common path is three map reads and a
     * string compare.
     *
     * Called per frame rather than on assignment because source textures decode asynchronously — a map
     * assigned this frame may not have uploaded yet. A pack that cannot resolve simply is not recorded,
     * so the next frame retries. That is the whole retry mechanism; there is no queue.
     */
    public sync(material: Material, frame: number): void {
        if (!material) return;
        switch (material.type as string) {
            case 'pbr':
                this._syncPBR(material, frame);
                break;
            case 'blinn_phong':
            case 'blinn_phongSkinned':
                this._syncBlinnPhong(material, frame);
                break;
            // 'basic' has a single texture slot and nothing to combine; terrain composites are synced by
            // the Terrain subsystem, which owns its layer slots.
        }
    }

    /** Forget `material`'s binding. Optional — the sweep collects orphans anyway; this just does it sooner. */
    public release(material: Material): void {
        this._bindings.delete(material);
    }

    /** Collect packed textures that no material has asked for in a while. Call once per frame. */
    public sweep(frame: number): void {
        if (frame - this._lastSweep < TexturePacker.SWEEP_INTERVAL) return;
        this._lastSweep = frame;
        for (const [key, entry] of this._cache) {
            if (frame - entry.lastFrame < TexturePacker.SWEEP_INTERVAL) continue;
            entry.texture.delete();
            TextureManager.Instance.removeTexture(entry.id);
            this._cache.delete(key);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Spec construction
    // ---------------------------------------------------------------------------------------------

    /**
     * PBR: metallicMap + roughnessMap + occlusionMap -> one ORM texture in the `ormTexture` slot.
     *
     * A source's channel is inferred, not authored. A texture assigned to MORE than one of the three
     * slots is a pre-packed ORM map, so each slot takes its ORM channel; a texture in exactly one slot
     * is a standalone grayscale map and is read from red. That single rule covers both a hand-assigned
     * grayscale metallic map and a glTF import (which fans one image out to metallic+roughness, and
     * often occlusion too) with no channel picker in the UI.
     */
    private _syncPBR(material: Material, frame: number): void {
        const occlusion = material.textures.get('occlusionMap');
        const roughness = material.textures.get('roughnessMap');
        const metallic = material.textures.get('metallicMap');

        const flags = {
            hasOcclusionMap: !!occlusion,
            hasRoughnessMap: !!roughness,
            hasMetallicMap: !!metallic
        };

        if (!occlusion && !roughness && !metallic) {
            this._clear(material, 'ormTexture', flags);
            return;
        }

        const uses = new Map<string, number>();
        for (const id of [occlusion, roughness, metallic])
            if (id) uses.set(id, (uses.get(id) || 0) + 1);
        const channelOf = (id: string, orm: 0 | 1 | 2): 0 | 1 | 2 => (uses.get(id) || 0) > 1 ? orm : 0;

        this._bind(material, 'ormTexture', {
            r: occlusion ? { textureId: occlusion, channel: channelOf(occlusion, 0) } : { constant: 1, ignored: true },
            g: roughness ? { textureId: roughness, channel: channelOf(roughness, 1) } : { constant: 1, ignored: true },
            b: metallic ? { textureId: metallic, channel: channelOf(metallic, 2) } : { constant: 1, ignored: true },
            // Nothing reads the ORM alpha; leaving it free keeps a channel available for later.
            a: { constant: 1, ignored: true }
        }, flags, frame);
    }

    /**
     * Blinn-Phong: specularMap (rgb) + reflectivityMap -> one `specularReflectivityMap`, reflectivity in
     * alpha. Note this only pays off in the forward `default.fs` — the deferred `geometryDefault.fs`
     * samples neither map (it derives metallic from the scalar `reflectivity`), so a deferred
     * blinn-phong material bakes and binds this for nothing. Materials don't know their pipeline, and
     * gating on it would be a hidden coupling for one bind.
     */
    private _syncBlinnPhong(material: Material, frame: number): void {
        const specular = material.textures.get('specularMap');
        const reflectivity = material.textures.get('reflectivityMap');

        const flags = { hasSpecularMap: !!specular, hasReflectivityMap: !!reflectivity };

        if (!specular && !reflectivity) {
            this._clear(material, 'specularReflectivityMap', flags);
            return;
        }

        // Reflectivity was historically read from blue (the metallic channel of a packed metal/rough
        // map); a standalone map is grayscale, so red is the same value either way.
        this._bind(material, 'specularReflectivityMap', {
            r: specular ? { textureId: specular, channel: 0 } : { constant: 1, ignored: true },
            g: specular ? { textureId: specular, channel: 1 } : { constant: 1, ignored: true },
            b: specular ? { textureId: specular, channel: 2 } : { constant: 1, ignored: true },
            a: reflectivity ? { textureId: reflectivity, channel: 0 } : { constant: 1, ignored: true }
        }, flags, frame);
    }

    /**
     * Pack `spec` into `slot` on `material` and set the `has*` flags the shader guards its reads with.
     *
     * While the pack is unresolved (a source still decoding) the slot gets a 1x1 white placeholder and
     * every flag goes false, so the shader falls through to its scalar factors — the same path a
     * material with no maps takes. The placeholder is not cosmetic: an unset sampler uniform defaults to
     * texture unit 0, which would sample the BASE COLOUR map as ORM for those frames.
     */
    private _bind(material: Material, slot: string, spec: PackSpec, flags: Record<string, boolean>, frame: number): void {
        const key = this._specKey(spec);
        const bound = this._bindings.get(material);
        if (bound && bound.key === key && bound.slot === slot) {
            const entry = this._cache.get(key);
            if (entry) entry.lastFrame = frame;   // a cached bake stays alive while it is in use
            if (entry || material.textures.has(slot)) {
                for (const [name, value] of Object.entries(flags)) material.properties.set(name, value);
                return;
            }
            // The texture was swept or removed out from under us — fall through and re-resolve.
        }

        const id = this.resolve(spec, frame);
        if (!id) {
            this._bindings.delete(material);
            material.textures.set(slot, this._placeholderId());
            for (const name of Object.keys(flags)) material.properties.set(name, false);
            return;
        }

        material.textures.set(slot, id);
        for (const [name, value] of Object.entries(flags)) material.properties.set(name, value);
        this._bindings.set(material, { key, slot });
    }

    /** Drop a derived slot entirely (the material has no source maps for it). */
    private _clear(material: Material, slot: string, flags: Record<string, boolean>): void {
        this._bindings.delete(material);
        material.textures.delete(slot);
        for (const name of Object.keys(flags)) material.properties.set(name, false);
    }

    // ---------------------------------------------------------------------------------------------
    // Resolution
    // ---------------------------------------------------------------------------------------------

    /**
     * The texture id `spec` resolves to, or null if a source has not finished decoding yet (callers
     * retry next frame). Order matters: cache, then the identity fast path, then a bake.
     */
    public resolve(spec: PackSpec, frame: number): string | null {
        const key = this._specKey(spec);
        const hit = this._cache.get(key);
        if (hit) { hit.lastFrame = frame; return hit.id; }

        const channels = [spec.r, spec.g, spec.b, spec.a];
        const sources: string[] = [];
        for (const source of channels) {
            if ('constant' in source) continue;
            const texture = TextureManager.Instance.getTexture(source.textureId);
            // width is 0 until the image decodes (TextureManager registers the id synchronously).
            if (!texture || texture.width === 0 || texture.height === 0) return null;
            if (!sources.includes(source.textureId)) sources.push(source.textureId);
        }
        if (sources.length === 0) return null; // an all-constant spec has nothing worth a texture

        // Identity: every channel either comes from the one source at its own index, or is a constant
        // the shader won't read. Reuse the source verbatim — no bake, no cache entry, no VRAM. This is
        // the glTF path, and it is why importing a packed ORM map costs exactly nothing.
        if (sources.length === 1 && channels.every((source, i) =>
            'constant' in source ? source.ignored === true : source.channel === i)) return sources[0];

        return this._bake(key, spec, sources, frame);
    }

    /** Stable key for a spec. Two materials with the same sources share one packed texture. */
    private _specKey(spec: PackSpec): string {
        const part = (source: ChannelSource) =>
            'constant' in source ? `#${source.constant}` : `${source.textureId}.${source.channel}`;
        return `${part(spec.r)}|${part(spec.g)}|${part(spec.b)}|${part(spec.a)}`;
    }

    // ---------------------------------------------------------------------------------------------
    // The bake
    // ---------------------------------------------------------------------------------------------

    /**
     * Render `spec` into a fresh RGBA8 texture and register it.
     *
     * Uses a private framebuffer rather than the `Framebuffer` class for the same reason
     * `Renderer._bakeCloudNoise` does: that class allocates and OWNS its colour attachments and
     * reallocates them on resize, which is the opposite of attaching one externally-owned texture once.
     */
    private _bake(key: string, spec: PackSpec, sources: string[], frame: number): string | null {
        const shader = this._ensureShader();
        const quad = this._ensureQuad(shader);
        const textures = sources.map(id => TextureManager.Instance.getTexture(id)!);

        let width = 1, height = 1;
        let minWidth = Infinity, minHeight = Infinity;
        for (const texture of textures) {
            width = Math.max(width, texture.width);
            height = Math.max(height, texture.height);
            minWidth = Math.min(minWidth, texture.width);
            minHeight = Math.min(minHeight, texture.height);
        }
        width = Math.min(width, TexturePacker.MAX_SIZE);
        height = Math.min(height, TexturePacker.MAX_SIZE);
        // Mismatched sources are resampled to the largest, so the small one is upscaled and the packed
        // texture costs the large one's footprint. Fine for scalar channels, but worth saying out loud.
        if (width > minWidth * 2 || height > minHeight * 2)
            Logger.warn(`Packing sources of very different sizes (${minWidth}x${minHeight} into ${width}x${height}); the smaller map is upscaled`, 'TexturePacker');

        // One texture can only have one wrap mode. Sources that disagree are an authoring error; first
        // wins, because there is no answer that satisfies both.
        const wrapping = textures[0].config.wrapping;
        for (const texture of textures) {
            if (texture.config.wrapping === wrapping) continue;
            Logger.warn(`Packing sources with different wrapping modes; using '${wrapping}' for all channels`, 'TexturePacker');
            break;
        }

        if (!this._fbo) this._fbo = device.createFramebuffer('channelPack');

        const output = new Texture({ mipMap: true, precision: 'low', wrapping });
        output.create(null, width, height);

        this._fbo.bind();
        this._fbo.attachColor2D(0, output.texture);
        // Worth checking: an incomplete framebuffer drops the draw silently and the texture keeps
        // whatever texImage2D left in it, which reads as a plausible-looking flat material.
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            Logger.print('error', ['Channel-pack framebuffer incomplete:', status], 'TexturePacker');
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            output.delete();
            return null;
        }

        const channels = [spec.r, spec.g, spec.b, spec.a];
        const srcIndex = channels.map(source => 'constant' in source ? -1 : sources.indexOf(source.textureId));
        const srcChannel = channels.map(source => 'constant' in source ? 0 : source.channel);
        const constants = channels.map(source => 'constant' in source ? source.constant : 0);

        GLState.disable(gl.DEPTH_TEST);
        GLState.depthMask(false);
        GLState.disable(gl.BLEND);
        GLState.disable(gl.CULL_FACE);
        gl.viewport(0, 0, width, height);
        setViewportSize(width, height);

        ShaderManager.Instance.bind('channelPack');
        for (let unit = 0; unit < 4; unit++) {
            ShaderManager.Instance.setUniform(`u_src${unit}`, unit);
            // Unused samplers alias source 0 rather than being left unbound: an unbound sampler2D is
            // incomplete, and reading one is undefined behaviour even on a branch that never executes.
            (textures[unit] || textures[0]).bind(unit);
        }
        ShaderManager.Instance.setUniform('u_srcIndex', srcIndex);
        ShaderManager.Instance.setUniform('u_srcChannel', srcChannel);
        ShaderManager.Instance.setUniform('u_const', constants);
        quad.draw(); // not a counted fullscreen pass: a one-off bake is not part of the frame

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        GLState.depthMask(true);
        GLState.enable(gl.DEPTH_TEST);
        // Every subsequent pass sets its own viewport when it binds a target; restoring the canvas size
        // here would be wrong while an offscreen capture is in flight.

        output.generateMipmaps();

        const id = PACKED_ID_PREFIX + cyrb53(key);
        TextureManager.Instance.addTexture(output, id);
        this._cache.set(key, { id, texture: output, lastFrame: frame });
        return id;
    }

    // ---------------------------------------------------------------------------------------------
    // Lazily-built GL resources
    // ---------------------------------------------------------------------------------------------

    /**
     * Self-registers the pack program on first use instead of being built with the rest of the shaders
     * in `Renderer`, so a project with no packed materials pays nothing and the packer stays
     * self-contained.
     */
    private _ensureShader(): Shader {
        const existing = ShaderManager.Instance.find('channelPack');
        if (existing) return existing;
        const shader = new Shader().create(ScreenVertex, ChannelPackFragment);
        ShaderManager.Instance.addShader('channelPack', shader);
        return shader;
    }

    /** A private screen quad — 4 vertices, ~80 bytes — rather than a public accessor on the Renderer. */
    private _ensureQuad(shader: Shader): Mesh {
        if (this._quad) return this._quad;
        const quad = new Mesh();
        quad.initializeVAO(shader.attributes);
        quad.create([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 1, 1, 0, 1, 1, -1, 1, 0, 0, 1], 12, [0, 1, 2, 0, 2, 3]);
        this._quad = quad;
        return quad;
    }

    /** 1x1 white, bound into derived slots whose pack has not resolved yet. */
    private _placeholderId(): string {
        if (this._placeholder) return this._placeholder;
        const texture = new Texture({ mipMap: false });
        texture.createFromData(new Uint8Array([255, 255, 255, 255]), 1, 1);
        this._placeholder = TextureManager.Instance.addTexture(texture, PACKED_ID_PREFIX + 'pending');
        return this._placeholder;
    }
}
