import { v4 as uuidv4 } from 'uuid';
import { Material, TerrainMaterial } from '../graphics/material';
import { Texture } from '../graphics/texture';
import { TextureManager } from '../graphics/systems/textureManager';
import { bytesToBase64, base64ToBytes } from '../core/base64';
import { Logger } from '../core/logger';
import {
    MAX_TERRAIN_SURFACES, MAX_PAINT_LAYERS, MASK_CHANNELS_PER_SLICE, deriveSurface, flattenSurfaces,
    surfaceWeightsAt, legacyAutoRule, legacySplatAlphas, slopeDegreesFromNormalY,
    type TerrainFlatSurface, type TerrainLayerSource, type TerrainSlotSource,
} from './terrainLayers';
import { MaskGrid, type MaskPaint, type MaskRegion, type MaskPatch } from './terrainMasks';
import { TerrainSurfaceArrays, DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE } from './terrainSurfaceArrays';

// A landscape's layer stack: the BASE layer (one landscape material, covering everything) and the PAINT
// layers over it (each a landscape material plus a painted mask), with the GPU resources that draw them.
// See terrainLayers.ts for the model and chunks/terrainStack.wgsl for the shader.
//
// Owned by `Terrain`, which forwards to it; kept apart so the whole of "what is painted where" lives in
// one place, with the height field, chunks and physics on the other side of the line.

/** A layer's identity, as the editor and serialization see it. */
export interface TerrainPaintLayer {
    id: string;
    name: string;
    material: TerrainMaterial | null;
    /** Landscape-material library asset id (edit propagation). */
    materialId: string | null;
    visible: boolean;
    /** 0..1, multiplies every slot of this layer. */
    opacity: number;
    /** The mask channel this layer paints into. Stable for the layer's lifetime; a reorder does not move it. */
    channel: number;
}

export interface TerrainBaseLayer {
    material: TerrainMaterial | null;
    materialId: string | null;
}

/**
 * The layer list at one moment, for undo. Holds the live material OBJECTS rather than copies: assigning a
 * material replaces the object, it never mutates the old one, so a reference is an exact snapshot and
 * costs nothing — unlike a serialize, which would also have to rebuild every foliage prototype on restore.
 */
export interface StackLayersSnapshot {
    base: TerrainBaseLayer;
    paint: TerrainPaintLayer[];
}

/** Everything a layer contributes at one point, for gameplay and foliage queries. */
export interface TerrainLayerWeights {
    /** Final weight of the base layer and of each paint layer (in stack order), summing to <= 1. */
    base: number;
    paint: number[];
    /** Weight of surfaces that forbid foliage. */
    noFoliage: number;
}

/** The mask resolution a landscape gets when none is authored: twice the height grid, capped at 1024. */
export function defaultMaskResolution(heightResolution: number): number {
    let p = 1;
    while (p < Math.max(1, heightResolution - 1)) p *= 2;
    return Math.max(64, Math.min(1024, p * 2));
}

/** Slot sources of one landscape material, slot 0 first. */
export function materialSlots(tm: TerrainMaterial): TerrainSlotSource[] {
    const out: TerrainSlotSource[] = [{
        surface: deriveSurface(tm, tm.tiling, tm.invertHeight),
        rule: tm.rule,
        allowFoliage: tm.allowFoliage,
    }];
    for (const s of tm.slots) {
        out.push({
            surface: deriveSurface(s.material, s.tiling, !!s.material.properties.get('invertHeight')),
            rule: s.rule,
            allowFoliage: s.allowFoliage,
        });
    }
    return out;
}

/** A legacy plain-albedo layer as a one-slot Basic landscape material. */
export function legacyAlbedoMaterial(textureId: string, tiling: number): TerrainMaterial {
    const tm = TerrainMaterial.Create('basic', { texture: textureId, color: [1, 1, 1] });
    tm.tiling = tiling;
    return tm;
}

export class TerrainLayerStack {
    private _base: TerrainBaseLayer = { material: null, materialId: null };
    private _paint: TerrainPaintLayer[] = [];
    private _masks: MaskGrid;
    private _size: number;

    private _maskTex: Texture | null = null;
    private _maskId: string | null = null;
    private _maskSlicesOnGpu = 0;
    /** Mask rectangles written on the CPU but not yet on the GPU, per slice. */
    private _maskDirty: Map<number, MaskRegion> = new Map();

    private _arrays = new TerrainSurfaceArrays();
    private _surfaces: TerrainFlatSurface[] | null = null;
    private _truncated = false;
    private _debugSurface = -1;
    private _originY = 0;
    /** Bumped on every change a consumer caching the stack (the editor's panels) should notice. */
    public version = 0;

    constructor(size: number, maskResolution: number) {
        this._size = size;
        this._masks = new MaskGrid(maskResolution, size, MASK_CHANNELS_PER_SLICE);
    }

    // --- layers -----------------------------------------------------------------------------

    public get base(): Readonly<TerrainBaseLayer> { return this._base; }
    /** Paint layers, bottom to top. */
    public get paintLayers(): readonly TerrainPaintLayer[] { return this._paint; }
    public get masks(): MaskGrid { return this._masks; }
    public get maskResolution(): number { return this._masks.resolution; }
    /** True when the stack has more surfaces than the shader draws; the topmost are dropped. */
    public get truncated(): boolean { this.surfaces(); return this._truncated; }

    public paintLayer(id: string): TerrainPaintLayer | undefined {
        return this._paint.find(l => l.id === id);
    }

    /** Assign the base layer's material (null clears it to the flat base colour). */
    public setBase(material: TerrainMaterial | null, materialId: string | null = null): void {
        this._base = { material, materialId };
        this._changed();
    }

    /**
     * Add a paint layer on top of the stack. Returns null when every mask channel is taken or the
     * layer count is at its cap.
     */
    public addPaintLayer(material: TerrainMaterial | null, opts: Partial<Omit<TerrainPaintLayer, 'channel'>> = {}): TerrainPaintLayer | null {
        if (this._paint.length >= MAX_PAINT_LAYERS) return null;
        const channel = this._freeChannel();
        if (this._masks.ensureChannels(channel + 1)) this._maskSlicesOnGpu = -1; // reallocate on next sync
        // A fresh layer starts unpainted, whatever a previous owner of the channel left behind.
        this._fillChannel(channel, 0);
        const layer: TerrainPaintLayer = {
            id: opts.id ?? `layer_${uuidv4().slice(0, 8)}`,
            name: opts.name ?? `Layer ${this._paint.length + 1}`,
            material,
            materialId: opts.materialId ?? null,
            visible: opts.visible ?? true,
            opacity: opts.opacity ?? 1,
            channel,
        };
        this._paint.push(layer);
        this._changed();
        return layer;
    }

    /** Remove a paint layer. Its mask is cleared so a later layer on the same channel starts clean. */
    public removePaintLayer(id: string): boolean {
        const i = this._paint.findIndex(l => l.id === id);
        if (i < 0) return false;
        const [layer] = this._paint.splice(i, 1);
        this._fillChannel(layer.channel, 0);
        this._changed();
        return true;
    }

    /** Move a paint layer to `index` in the stack (0 = just above the base). Masks stay with their layers. */
    public movePaintLayer(id: string, index: number): boolean {
        const from = this._paint.findIndex(l => l.id === id);
        if (from < 0) return false;
        const to = Math.max(0, Math.min(this._paint.length - 1, index));
        if (to === from) return false;
        const [layer] = this._paint.splice(from, 1);
        this._paint.splice(to, 0, layer);
        this._changed();
        return true;
    }

    /** Patch a paint layer's name, visibility, opacity or material. */
    public updatePaintLayer(id: string, patch: Partial<Pick<TerrainPaintLayer, 'name' | 'visible' | 'opacity' | 'material' | 'materialId'>>): boolean {
        const layer = this.paintLayer(id);
        if (!layer) return false;
        if (patch.name !== undefined) layer.name = patch.name;
        if (patch.visible !== undefined) layer.visible = patch.visible;
        if (patch.opacity !== undefined) layer.opacity = Math.max(0, Math.min(1, patch.opacity));
        if (patch.material !== undefined) layer.material = patch.material;
        if (patch.materialId !== undefined) layer.materialId = patch.materialId;
        this._changed();
        return true;
    }

    /** The layer list as it is now; see {@link StackLayersSnapshot}. Masks are not included. */
    public snapshotLayers(): StackLayersSnapshot {
        return { base: { ...this._base }, paint: this._paint.map(l => ({ ...l })) };
    }

    /** Put a snapshot's layer list back. Masks are left as they are; restore them with {@link writeMaskPatches}. */
    public restoreLayers(s: StackLayersSnapshot): void {
        this._base = { ...s.base };
        this._paint = s.paint.map(l => ({ ...l }));
        let top = 0;
        for (const l of this._paint) top = Math.max(top, l.channel + 1);
        if (this._masks.ensureChannels(top)) this._maskSlicesOnGpu = -1;
        this._changed();
    }

    /**
     * Take over another stack's layers and masks — what a Rebuild does when it swaps a new Terrain onto
     * the node. Masks are resampled by position, so a size or resolution change stretches the painting
     * with the landscape. Materials are SHARED with `other`, which is about to be disposed; a material
     * holds no GPU resources, so there is nothing to double-free.
     */
    public copyFrom(other: TerrainLayerStack): void {
        this.restoreLayers(other.snapshotLayers());
        this._masks.resampleFrom(other._masks);
        this._maskSlicesOnGpu = -1;
        this._changed();
    }

    /** Call after mutating a layer's material in place (the terrain-material editor does). */
    public materialsChanged(): void { this._changed(); }

    private _freeChannel(): number {
        const used = new Set(this._paint.map(l => l.channel));
        let c = 0;
        while (used.has(c)) c++;
        return c;
    }

    private _changed(): void {
        this._surfaces = null;
        this.version++;
    }

    // --- masks ------------------------------------------------------------------------------

    /** Paint a layer's mask. Landscape-local brush coordinates. Returns the changed region or null. */
    public paint(id: string, p: MaskPaint): MaskRegion | null {
        const layer = this.paintLayer(id);
        if (!layer) return null;
        const reg = this._masks.paint(layer.channel, p);
        if (reg) this._markMaskDirty(layer.channel, reg);
        return reg;
    }

    /** Fill (1), clear (0) or set a whole layer's mask. */
    public fillMask(id: string, value: number): boolean {
        const layer = this.paintLayer(id);
        if (!layer) return false;
        return this._fillChannel(layer.channel, value);
    }

    public invertMask(id: string): boolean {
        const layer = this.paintLayer(id);
        if (!layer) return false;
        const reg = this._masks.invert(layer.channel);
        if (reg) this._markMaskDirty(layer.channel, reg);
        return !!reg;
    }

    /** Clear EVERY paint layer under a brush — the "restore the base" tool. Returns the union region. */
    public paintAllToZero(p: Omit<MaskPaint, 'target'>): MaskRegion | null {
        let out: MaskRegion | null = null;
        for (const layer of this._paint) {
            const reg = this._masks.paint(layer.channel, { ...p, target: 0 });
            if (!reg) continue;
            this._markMaskDirty(layer.channel, reg);
            out = out ? {
                c0: Math.min(out.c0, reg.c0), r0: Math.min(out.r0, reg.r0),
                c1: Math.max(out.c1, reg.c1), r1: Math.max(out.r1, reg.r1),
            } : reg;
        }
        return out;
    }

    /** Save a region of every paint layer's mask, for undo. */
    public readMaskPatches(region: MaskRegion): MaskPatch[] {
        return this._paint.map(l => this._masks.readPatch(l.channel, region));
    }

    /** Put saved mask regions back (undo/redo). */
    public writeMaskPatches(patches: readonly MaskPatch[]): void {
        for (const p of patches) {
            if (p.channel >= this._masks.capacity) continue;
            this._masks.writePatch(p);
            this._markMaskDirty(p.channel, p.region);
        }
    }

    /** Mask value of a layer at landscape-local x/z, 0..1. */
    public maskAt(id: string, x: number, z: number): number {
        const layer = this.paintLayer(id);
        return layer ? this._masks.sample(layer.channel, x, z) : 0;
    }

    /** Fraction of the landscape where a layer's mask is at least half on. */
    public coverage(id: string): number {
        const layer = this.paintLayer(id);
        return layer ? this._masks.coverage(layer.channel) : 0;
    }

    private _fillChannel(channel: number, value: number): boolean {
        const reg = this._masks.fill(channel, value);
        if (reg) this._markMaskDirty(channel, reg);
        return !!reg;
    }

    private _markMaskDirty(channel: number, reg: MaskRegion): void {
        const slice = Math.floor(channel / MASK_CHANNELS_PER_SLICE);
        const prev = this._maskDirty.get(slice);
        this._maskDirty.set(slice, prev ? {
            c0: Math.min(prev.c0, reg.c0), r0: Math.min(prev.r0, reg.r0),
            c1: Math.max(prev.c1, reg.c1), r1: Math.max(prev.r1, reg.r1),
        } : { ...reg });
    }

    // --- surfaces & queries -----------------------------------------------------------------

    /** The layers as the flattening sees them, base first. */
    private _sources(): TerrainLayerSource[] {
        const out: TerrainLayerSource[] = [];
        out.push({ slots: this._base.material ? materialSlots(this._base.material) : [], mask: -1, visible: true, opacity: 1 });
        for (const L of this._paint)
            out.push({ slots: L.material ? materialSlots(L.material) : [], mask: L.channel, visible: L.visible, opacity: L.opacity });
        return out;
    }

    /** The flat surface list the shader composites, bottom to top. Cached until the stack changes. */
    public surfaces(): readonly TerrainFlatSurface[] {
        if (!this._surfaces) {
            const { surfaces, truncated } = flattenSurfaces(this._sources());
            if (truncated && !this._truncated)
                Logger.warn(`This landscape has more than ${MAX_TERRAIN_SURFACES} surfaces; the topmost are not drawn.`, 'Terrain');
            this._surfaces = surfaces;
            this._truncated = truncated;
        }
        return this._surfaces;
    }

    /**
     * What each layer contributes at a point, for foliage placement and gameplay queries: the CPU twin
     * of the shader's compositing, summed per layer.
     *
     * @param x, z       Landscape-local position (for the masks).
     * @param elevation  Metres above the landscape origin.
     * @param normalY    Y of the ground's unit normal there.
     * @param worldX, worldZ World position (for the rule noise, which the shader reads in world space).
     */
    public layerWeightsAt(x: number, z: number, elevation: number, normalY: number,
                          worldX: number, worldZ: number): TerrainLayerWeights {
        const surfaces = this.surfaces();
        const weights: number[] = [];
        surfaceWeightsAt(surfaces, ch => this._masks.sample(ch, x, z), elevation,
                         slopeDegreesFromNormalY(normalY), worldX, worldZ, weights);
        const out: TerrainLayerWeights = { base: 0, paint: this._paint.map(() => 0), noFoliage: 0 };
        for (let i = 0; i < surfaces.length; i++) {
            const s = surfaces[i], w = weights[i];
            if (s.layer === 0) out.base += w;
            else out.paint[s.layer - 1] += w;
            if (!s.allowFoliage) out.noFoliage += w;
        }
        return out;
    }

    // --- GPU --------------------------------------------------------------------------------

    /** Metres-above-origin conversion for the elevation rule: set to the landscape's world Y. */
    public setOriginY(y: number): void { this._originY = y; }

    /** Authoring view: -1 off, -2 all surfaces coloured, >= 0 one surface's weight. */
    public get debugSurface(): number { return this._debugSurface; }
    public set debugSurface(v: number) { this._debugSurface = Math.round(v); }

    /**
     * Bring the GPU copies up to date and write every uniform into `material`. Call once per frame from
     * the renderer's pre-pass hook, where no pass is open (the array bakes are passes of their own).
     *
     * @param elevRemap Overrides the landscape's `(1, -originY)` — the preview maps its small subject
     *                  onto a material's rule span with this.
     */
    public sync(material: Material, layerTextureSize = DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE,
                elevRemap?: [number, number], tilingScale = 1): void {
        this._syncMaskTexture();
        this._arrays.sync(this.surfaces().map(s => s.surface), layerTextureSize);
        this.writeUniforms(material, elevRemap, tilingScale);
    }

    /**
     * Write the stack's textures and every surface uniform into `material` — the CPU half of
     * {@link sync}, with no device involved, so what the shader is told can be tested directly.
     */
    public writeUniforms(material: Material, elevRemap?: [number, number], tilingScale = 1): void {
        const surfaces = this.surfaces();
        const m = material;
        if (this._maskId) m.textures.set('u_masks', this._maskId); else m.textures.delete('u_masks');
        if (this._arrays.albedoId) m.textures.set('u_surfAlbedo', this._arrays.albedoId); else m.textures.delete('u_surfAlbedo');
        if (this._arrays.normalId) m.textures.set('u_surfNormal', this._arrays.normalId); else m.textures.delete('u_surfNormal');

        const n = MAX_TERRAIN_SURFACES * 4;
        const color = new Float32Array(n), mat = new Float32Array(n), flags = new Float32Array(n);
        const elevation = new Float32Array(n), slope = new Float32Array(n), noise = new Float32Array(n);
        const blend = new Float32Array(n);
        for (let i = 0; i < surfaces.length; i++) {
            const s = surfaces[i], o = i * 4, d = s.surface, r = s.rule;
            color[o] = d.color[0] ?? 1; color[o + 1] = d.color[1] ?? 1; color[o + 2] = d.color[2] ?? 1;
            color[o + 3] = d.invertHeight ? 1 : 0;
            mat[o] = d.metallic; mat[o + 1] = d.roughness; mat[o + 2] = d.tiling * tilingScale;
            mat[o + 3] = s.fill ? -2 : s.mask;
            flags[o] = d.albedoId ? 1 : 0; flags[o + 1] = d.aoId ? 1 : 0;
            flags[o + 2] = d.normalId ? 1 : 0; flags[o + 3] = d.heightId ? 1 : 0;
            elevation[o] = r.elevation.min; elevation[o + 1] = r.elevation.max;
            elevation[o + 2] = r.elevation.falloff; elevation[o + 3] = r.elevation.enabled ? 1 : 0;
            slope[o] = r.slope.min; slope[o + 1] = r.slope.max;
            slope[o + 2] = r.slope.falloff; slope[o + 3] = r.slope.enabled ? 1 : 0;
            noise[o] = r.noise.amount; noise[o + 1] = 1 / Math.max(r.noise.scale, 0.01);
            // The seed offsets ruleNoise adds, pre-multiplied here so the shader does not.
            noise[o + 2] = r.noise.seed * 19.19; noise[o + 3] = r.noise.seed * 7.73;
            blend[o] = r.heightBlend; blend[o + 1] = r.opacity;
        }
        m.properties.set('u_surfCount', surfaces.length);
        m.properties.set('u_debugSurface', this._debugSurface);
        m.properties.set('u_elevRemap', elevRemap ?? [1, -this._originY]);
        m.properties.set('u_surfColor', color);
        m.properties.set('u_surfMaterial', mat);
        m.properties.set('u_surfFlags', flags);
        m.properties.set('u_surfElevation', elevation);
        m.properties.set('u_surfSlope', slope);
        m.properties.set('u_surfNoise', noise);
        m.properties.set('u_surfBlend', blend);
    }

    private _syncMaskTexture(): void {
        const slices = this._masks.slices, res = this._masks.resolution;
        if (!this._maskTex || this._maskSlicesOnGpu !== slices) {
            // Immutable storage: a new slice count is a new texture, filled whole.
            this._disposeMaskTexture();
            const tex = new Texture({ target: 'texture2DArray', mipMap: false, wrapping: 'clamp' });
            tex.createColorArray(res, res, slices, false);
            const full = this._masks.fullRegion();
            for (let s = 0; s < slices; s++) tex.writeLayer(s, 0, 0, res, res, this._masks.sliceRect(s, full));
            this._maskId = `__editor__terrain_masks_${uuidv4()}`;
            TextureManager.Instance.addTexture(tex, this._maskId);
            this._maskTex = tex;
            this._maskSlicesOnGpu = slices;
            this._maskDirty.clear();
            return;
        }
        for (const [slice, reg] of this._maskDirty) {
            const bytes = this._masks.sliceRect(slice, reg);
            this._maskTex.writeLayer(slice, reg.c0, reg.r0, reg.c1 - reg.c0 + 1, reg.r1 - reg.r0 + 1, bytes);
        }
        this._maskDirty.clear();
    }

    private _disposeMaskTexture(): void {
        if (this._maskTex) this._maskTex.delete();
        if (this._maskId) TextureManager.Instance.removeTexture(this._maskId);
        this._maskTex = null;
        this._maskId = null;
    }

    /** Re-bake every surface layer next sync (a source texture was replaced under the same id). */
    public invalidateSurfaceTextures(): void { this._arrays.invalidate(); }

    public dispose(): void {
        this._disposeMaskTexture();
        this._arrays.dispose();
    }

    // --- serialization ----------------------------------------------------------------------

    public serialize(): any {
        const slices = this._masks.slices;
        return {
            layerFormat: 2,
            base: {
                materialId: this._base.materialId,
                material: this._base.material ? this._base.material.serialize() : null,
            },
            paintLayers: this._paint.map(L => ({
                id: L.id, name: L.name, visible: L.visible, opacity: L.opacity, channel: L.channel,
                materialId: L.materialId,
                material: L.material ? L.material.serialize() : null,
            })),
            maskRes: this._masks.resolution,
            maskSlices: slices,
            masks: bytesToBase64(this._masks.data),
        };
    }

    /**
     * Restore a stack saved by {@link serialize}. `maskBytes` is the pre-decoded form the published-game
     * loader supplies (inflated out of game.bin); otherwise `json.masks` is base64.
     */
    public load(json: any, maskBytes?: Uint8Array | null): void {
        const bytes = maskBytes ?? (typeof json.masks === 'string' ? base64ToBytes(json.masks) : null);
        const res = json.maskRes ?? this._masks.resolution;
        const slices = Math.max(1, json.maskSlices ?? 1);
        if (bytes) {
            if (res === this._masks.resolution) this._masks.load(bytes, res, slices);
            else {
                const saved = new MaskGrid(res, this._size, slices * MASK_CHANNELS_PER_SLICE);
                saved.load(bytes, res, slices);
                this._masks.resampleFrom(saved);
                Logger.warn(`Landscape masks were saved at ${res}x${res} but this landscape paints at ` +
                            `${this._masks.resolution}x${this._masks.resolution} — resampled.`, 'Terrain');
            }
        }
        const base = json.base ?? {};
        this._base = {
            material: base.material ? TerrainMaterial.parse(base.material) : null,
            materialId: base.materialId ?? null,
        };
        this._paint = [];
        for (const lj of Array.isArray(json.paintLayers) ? json.paintLayers : []) {
            if (this._paint.length >= MAX_PAINT_LAYERS) break;
            const channel = Number.isInteger(lj.channel) && lj.channel >= 0 ? lj.channel : this._freeChannel();
            this._masks.ensureChannels(channel + 1);
            this._paint.push({
                id: typeof lj.id === 'string' ? lj.id : `layer_${uuidv4().slice(0, 8)}`,
                name: typeof lj.name === 'string' ? lj.name : `Layer ${this._paint.length + 1}`,
                material: lj.material ? TerrainMaterial.parse(lj.material) : null,
                materialId: lj.materialId ?? null,
                visible: lj.visible !== false,
                opacity: typeof lj.opacity === 'number' ? Math.max(0, Math.min(1, lj.opacity)) : 1,
                channel,
            });
        }
        this._maskSlicesOnGpu = -1;
        this._changed();
    }

    /**
     * MIGRATION from the four-layer normalized splat (every landscape saved before the stack). Exact for
     * the painted weights: legacy layer 0 becomes the base, layers 1..3 paint layers whose masks are the
     * over-alphas that composite back to the same normalized weights (see `legacySplatAlphas`).
     *
     * @param layers     The old `layers` array: `{ material, materialId, textureId, tiling, auto, hRange, sRange }`.
     * @param splat      The old RGBA splat bytes (vertex-aligned, `splatRes` per side).
     * @param originY    The landscape's world Y, to re-base old WORLD-Y auto bands.
     */
    public loadLegacy(layers: any[], splat: Uint8Array | null, splatRes: number, originY = 0): void {
        const parse = (lj: any): TerrainMaterial | null => {
            if (!lj) return null;
            let tm: TerrainMaterial | null = null;
            if (lj.material) tm = TerrainMaterial.parse(lj.material);
            else if (lj.textureId) tm = legacyAlbedoMaterial(lj.textureId, lj.tiling ?? 20);
            if (!tm) return null;
            // Layer-level overrides were how the old slot tuned a shared material per landscape; they
            // live on this landscape's EMBEDDED copy now, where they render exactly as before.
            if (typeof lj.tiling === 'number') tm.tiling = lj.tiling;
            if (lj.auto !== undefined || lj.hRange || lj.sRange) {
                const heightBlend = tm.rule.heightBlend;
                tm.rule = legacyAutoRule(!!lj.auto, lj.hRange ?? tm.hRange, lj.sRange ?? tm.sRange, originY);
                tm.rule.heightBlend = heightBlend;
            }
            return tm;
        };

        const list = Array.isArray(layers) ? layers.slice(0, 4) : [];
        const base = parse(list[0]);
        this._base = { material: base, materialId: list[0]?.materialId ?? null };
        if (base) {
            // The old base had a rule too, and nothing below it to reveal: it covers whatever it says.
            base.rule.elevation.enabled = false;
            base.rule.slope.enabled = false;
        }
        this._paint = [];
        this._masks.ensureChannels(3);
        const legacy: (TerrainMaterial | null)[] = [];
        for (let k = 1; k < 4; k++) {
            const tm = parse(list[k]);
            legacy.push(tm);
            this._paint.push({
                id: `layer_${uuidv4().slice(0, 8)}`,
                name: `Layer ${k}`,
                material: tm,
                materialId: list[k]?.materialId ?? null,
                visible: true, opacity: 1, channel: k - 1,
            });
        }

        if (splat && splatRes > 1) {
            // The old splat is one texel per HEIGHT SAMPLE (vertex-aligned); the masks are texel-centred
            // at their own resolution. Resample bilinearly, converting to over-alphas per sample.
            const M = this._masks.resolution;
            const w = [0, 0, 0, 0], a = [0, 0, 0];
            const at = (c: number, r: number, k: number) => splat[(r * splatRes + c) * 4 + k] ?? 0;
            const out = this._masks.data;
            for (let r = 0; r < M; r++) {
                const gz = Math.min(Math.max(((r + 0.5) / M) * (splatRes - 1), 0), splatRes - 1);
                const r0 = Math.floor(gz), r1 = Math.min(r0 + 1, splatRes - 1), tz = gz - r0;
                for (let c = 0; c < M; c++) {
                    const gx = Math.min(Math.max(((c + 0.5) / M) * (splatRes - 1), 0), splatRes - 1);
                    const c0 = Math.floor(gx), c1 = Math.min(c0 + 1, splatRes - 1), tx = gx - c0;
                    for (let k = 0; k < 4; k++) {
                        const top = at(c0, r0, k) + (at(c1, r0, k) - at(c0, r0, k)) * tx;
                        const bot = at(c0, r1, k) + (at(c1, r1, k) - at(c0, r1, k)) * tx;
                        w[k] = top + (bot - top) * tz;
                    }
                    legacySplatAlphas(w[0], w[1], w[2], w[3], a);
                    const i = (r * M + c) * 4;
                    out[i] = Math.round(a[0] * 255);
                    out[i + 1] = Math.round(a[1] * 255);
                    out[i + 2] = Math.round(a[2] * 255);
                    out[i + 3] = 0;
                }
            }
        }
        // An unused legacy slot (no material, nothing painted) is not worth a layer in the new stack.
        this._paint = this._paint.filter((L, k) => legacy[k] || !this._masks.isEmpty(L.channel));
        this._maskSlicesOnGpu = -1;
        this._changed();
    }
}
