import { device } from '../rhi/deviceHandle';
import { Texture } from "../texture";
import type { ShaderProgram } from "../rhi/shaderProgram";
import type { ShaderModule, RenderPipeline } from '../rhi/resources';
import type { TextureFormat } from '../rhi/types';
import { ShaderStage } from '../rhi/types';
import { screenQuadLayout } from '../rhi/vertexLayouts';
import { Mesh } from "../mesh";
import { ShaderManager } from "./shaderManager";
import { TextureManager } from "./textureManager";
import { setViewportSize } from "../renderStats";
import { Logger } from "../../core/logger";
import { cyrb53 } from "../material";
import ChannelPackProgram from '../shaders/wgsl/channelPack.wgsl';
import type { Material } from "../material";

// -------------------------------------------------------------------------------------------------
// Channel packing: bake separately authored metallic/roughness/occlusion maps into one GPU texture and
// hand the material a derived slot. The layout is glTF's ORM, so an imported pre-packed map takes the
// identity fast path. Costs VRAM — the pack is allocated IN ADDITION to its sources, which stay
// resident for the editor's previews.
// -------------------------------------------------------------------------------------------------

/** One destination channel: a channel of a source texture, or a constant. */
export type ChannelSource =
    | { textureId: string; channel: 0 | 1 | 2 | 3 }
    /**
     * `ignored` marks a constant the shader will never read, so the channel need not be reproduced —
     * which is what lets an otherwise-identity spec skip the bake.
     */
    | { constant: number; ignored?: boolean };

/** The four destination channels of a packed texture. */
export interface PackSpec {
    r: ChannelSource;
    g: ChannelSource;
    b: ChannelSource;
    a: ChannelSource;
    /**
     * Wrap mode for the BAKED texture. Defaults to inheriting the first source's, which is what this
     * used to do unconditionally — and it is a trap, because a pack is sampled at the CALLER's tiling,
     * not its sources'.
     *
     * `Texture` defaults to `clamp`. A terrain layer samples its pack at `baseUv * tiling` with tiling
     * around 20-50, so a clamped pack shows one instance in the first tile and a stretched edge texel
     * across the rest of the terrain — the height and normal appear tens of times larger than the
     * albedo beside them, which repeats. That is a caller's concern, so the caller states it.
     */
    wrapping?: 'clamp' | 'repeat' | 'mirror';
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
    // The spec each material is bound to, so a per-frame `sync` is a string compare. WEAK: materials are
    // replaced wholesale and never disposed, so there is no hook to unregister from.
    private _bindings: WeakMap<Material, Binding> = new WeakMap();

    private _module: ShaderModule | null = null;
    private readonly _pipelines = new Map<TextureFormat, RenderPipeline>();
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
     * Bring `material`'s derived texture slots in line with its authored sources. Idempotent, and meant
     * to be called every frame: an unresolvable pack is simply not recorded, which IS the retry.
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
            // 'basic' has nothing to combine; terrain layer slots are synced by the Terrain subsystem.
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
     * PBR: metallicMap + roughnessMap + occlusionMap -> one ORM texture. A source's channel is INFERRED:
     * a texture in several slots is pre-packed and takes its ORM channel, one in a single slot reads red.
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
     * alpha. Only the forward path samples it; a deferred material bakes and binds this for nothing.
     */
    private _syncBlinnPhong(material: Material, frame: number): void {
        const specular = material.textures.get('specularMap');
        const reflectivity = material.textures.get('reflectivityMap');

        const flags = { hasSpecularMap: !!specular, hasReflectivityMap: !!reflectivity };

        if (!specular && !reflectivity) {
            this._clear(material, 'specularReflectivityMap', flags);
            return;
        }

        // A standalone reflectivity map is grayscale, so red carries the value.
        this._bind(material, 'specularReflectivityMap', {
            r: specular ? { textureId: specular, channel: 0 } : { constant: 1, ignored: true },
            g: specular ? { textureId: specular, channel: 1 } : { constant: 1, ignored: true },
            b: specular ? { textureId: specular, channel: 2 } : { constant: 1, ignored: true },
            a: reflectivity ? { textureId: reflectivity, channel: 0 } : { constant: 1, ignored: true }
        }, flags, frame);
    }

    // Pack `spec` into `slot` and set the `has*` flags the shader guards its reads with. While
    // unresolved the slot takes a 1x1 white PLACEHOLDER — an unset sampler defaults to unit 0, which
    // would sample the base colour map as ORM.
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
     * The texture id `spec` resolves to, or null while a source is still decoding. Order matters:
     * cache, then the identity fast path, then a bake.
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

        // Identity: every channel comes from one source at its own index, or is an ignored constant.
        // Reuse it verbatim — no bake, no cache entry, no VRAM.
        if (sources.length === 1 && channels.every((source, i) =>
            'constant' in source ? source.ignored === true : source.channel === i)) return sources[0];

        return this._bake(key, spec, sources, frame);
    }

    /**
     * Stable key for a spec. Two materials with the same sources share one packed texture.
     *
     * `wrapping` is PART OF THE KEY, and has to be: it is baked into the output texture's sampler, so
     * without it the first caller to request a given source/channel combination would decide the wrap
     * mode for every later caller, silently and invisibly — the sources themselves look identical.
     */
    private _specKey(spec: PackSpec): string {
        const part = (source: ChannelSource) =>
            'constant' in source ? `#${source.constant}` : `${source.textureId}.${source.channel}`;
        return `${part(spec.r)}|${part(spec.g)}|${part(spec.b)}|${part(spec.a)}@${spec.wrapping ?? 'src'}`;
    }

    // ---------------------------------------------------------------------------------------------
    // The bake
    // ---------------------------------------------------------------------------------------------

    /**
     * Render `spec` into a fresh RGBA8 texture and register it.
     *
     * Runs on the RHI, with its own encoder and its own one-shot pass. `_ensurePackedTextures` calls
     * this from a point in the frame where NO pass is open, which is what makes that possible — the
     * same shape `Renderer._bakeCloudNoise` uses for its compute dispatch.
     *
     * It was the last WebGL2-only path reachable from ordinary authored content: a private framebuffer,
     * `checkFramebufferStatus`, four `Texture.bind(unit)` calls and a `quad.draw()`. Nothing ever
     * reached it in a gated scene because no harness material had two DIFFERENT channel maps —
     * `resolve` takes an identity fast path when one source serves every channel — so on WebGPU it sat
     * behind a trigger nobody pulled, and `Mesh.draw` now throws by name when somebody does.
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

        // The caller's wrap mode wins when it states one, because the pack is sampled at the CALLER's
        // tiling and its sources' modes say nothing about that. Only when it does not are the sources
        // consulted — one texture can have one wrap mode, so a disagreement is an authoring error and
        // first wins, there being no answer that satisfies both.
        const wrapping = spec.wrapping ?? textures[0].config.wrapping;
        if (!spec.wrapping) {
            for (const texture of textures) {
                if (texture.config.wrapping === wrapping) continue;
                Logger.warn(`Packing sources with different wrapping modes; using '${wrapping}' for all channels`, 'TexturePacker');
                break;
            }
        }

        // A colour texture is already allocated RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_* (see
        // `Texture.create`), so there is nothing extra to declare in order to draw into it.
        const output = new Texture({ mipMap: true, precision: 'low', wrapping });
        output.create(null, width, height);

        const channels = [spec.r, spec.g, spec.b, spec.a];
        const srcIndex = channels.map(source => 'constant' in source ? -1 : sources.indexOf(source.textureId));
        const srcChannel = channels.map(source => 'constant' in source ? 0 : source.channel);
        const constants = channels.map(source => 'constant' in source ? source.constant : 0);

        // `checkFramebufferStatus` is gone: WebGPU validates the attachment itself, and an incomplete
        // WebGL2 framebuffer now surfaces the way every other target does rather than through a check
        // only this bake had.
        const target = device.createRenderTarget({
            label: 'channelPack', colorViews: [output.attachmentView],
        });
        const pipeline = this._packPipeline(shader, output.rhiTexture.format);

        // The viewport is the OUTPUT's size, and `setViewportSize` must be told — `renderStats`
        // charges shaded area by it.
        setViewportSize(width, height);

        const encoder = device.createCommandEncoder('channelPack');
        const pass = encoder.beginRenderPass(target, {
            label: 'channelPack',
            colorAttachments: [{ target: 0, loadOp: 'clear', storeOp: 'store',
                                 clearValue: [0, 0, 0, 1] }],
        });
        pass.setViewport(0, 0, width, height);
        pass.setPipeline(pipeline);

        ShaderManager.Instance.bind('channelPack');
        ShaderManager.Instance.setUniform('u_srcIndex', srcIndex);
        ShaderManager.Instance.setUniform('u_srcChannel', srcChannel);
        ShaderManager.Instance.setUniform('u_const', constants);

        // One bind group for all four pairs at binding 2N; the backend synthesises the sampler half.
        // Unused slots must ALIAS source 0 — a bind group may not have a hole.
        pass.setBindGroup(0, device.createBindGroup({
            label: 'channelPack:group0',
            layout: pipeline.layoutForGroup(0)!,
            entries: [0, 1, 2, 3].map(i => ({
                binding: i * 2, textureView: (textures[i] || textures[0]).sampledView,
            })),
        }));

        pass.setVertexBuffer(0, quad.vertexBuffer);
        pass.setIndexBuffer(quad.indexBuffer!, quad.indexFormat);
        pass.drawIndexed(quad.indexCount, 1, 0);   // not a counted pass: a one-off bake is not a frame
        pass.end();
        encoder.finish();

        output.generateMipmaps();

        const id = PACKED_ID_PREFIX + cyrb53(key);
        TextureManager.Instance.addTexture(output, id);
        this._cache.set(key, { id, texture: output, lastFrame: frame });
        return id;
    }

    // The pack pipeline, cached per output format: a WebGPU pipeline is a real object and would
    // otherwise accumulate for the life of the device. No depth, no blend, no cull.
    private _packPipeline(shader: ShaderProgram, format: TextureFormat): RenderPipeline {
        const existing = this._pipelines.get(format);
        if (existing) return existing;
        const pipeline = device.createRenderPipeline({
            label: 'channelPack',
            vertex: this._packModule(), fragment: this._packModule(),
            vertexLayouts: screenQuadLayout(shader.attributes),
            primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
            colorTargets: [{ format }],
        });
        this._pipelines.set(format, pipeline);
        return pipeline;
    }

    // The pack program's shader module, built once. Both stages come from one `channelPack.wgsl`.
    private _packModule(): ShaderModule {
        if (!this._module) this._module = device.createShaderModule({
            label: 'channelPack', program: 'channelPack',
            stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            source: ChannelPackProgram.wgsl,
            entryPoints: ChannelPackProgram.entryPoints,
            resources: ChannelPackProgram.resources,
        });
        return this._module;
    }

    // ---------------------------------------------------------------------------------------------
    // Lazily-built GL resources
    // ---------------------------------------------------------------------------------------------

    // Self-registers the pack program on first use, so a project with no packed materials pays nothing.
    private _ensureShader(): ShaderProgram {
        const existing = ShaderManager.Instance.find('channelPack');
        if (existing) return existing;
        const shader = device.createShaderProgram({ label: 'channelPack', ...ChannelPackProgram });
        ShaderManager.Instance.addShader('channelPack', shader);
        return shader;
    }

    // A private screen quad. Its V pairing is the BACKEND's, as `Renderer`'s shared quad picks it: a
    // GL texture's v=0 is its bottom row and a WebGPU texture's its top, so one pairing for both
    // mirrors the pack vertically on one of them.
    private _ensureQuad(shader: ShaderProgram): Mesh {
        if (this._quad) return this._quad;
        const quad = new Mesh();
        quad.initializeVAO(shader.attributes);
        const v0 = device.backend === 'webgl2' ? 0 : 1;   // the V that belongs with clip-space y = -1
        const v1 = 1 - v0;
        quad.create([-1, -1, 0, 0, v0,  1, -1, 0, 1, v0,
                      1,  1, 0, 1, v1, -1,  1, 0, 0, v1], 12, [0, 1, 2, 0, 2, 3]);
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
