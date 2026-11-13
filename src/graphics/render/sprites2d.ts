import { vec3, mat4 } from 'gl-matrix';
import { dissolveOf, packSpriteRecord, OBJECT_RECORD_FLOATS } from '../objectData';
import { quadClipRect, boxClipRect, CLIP_RECT_BOUNDED, CLIP_RECT_CULLED } from '../../core/math';
import { Geometry } from '../../core/geometry';
import { Mesh } from '../mesh';
import type { Sprite } from '../sprite';
import { SpriteBatchPlanner, StableArgsort, type BatchBoundsFn } from '../spriteBatching';
import type { DepthBand } from '../tilemap/tileMesh';
import type { Camera } from '../../core/camera';
import { Frustum } from '../../core/frustum';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import type { ParticleSystemNode } from '../../core/scene/nodes/particleSystemNode';
import { SpriteNode } from '../../core/scene/nodes/spriteNode';
import { TilemapNode } from '../../core/scene/nodes/tilemapNode';
import { Scene } from '../../core/scene/scene';
import { cellToWorld } from '../tilemap/cellMath';
import { TileChunk, CHUNK_SIZE } from '../tilemap/chunk';
import { Tilemap } from '../tilemap/tilemap';
import { TilemapLayer } from '../tilemap/tilemapLayer';
import { TileMesh } from '../tilemap/tileMesh';
import { frameStats } from '../renderStats';
import type { RenderPassEncoder } from '../rhi/device';
import type { RenderTarget } from '../rhi/resources';
import { DEFAULT_BLEND, SPRITE_ADDITIVE_BLEND, OVERLAY_BLEND } from '../rhi/types';
import type { BlendState } from '../rhi/types';
import { TextureManager } from '../systems/textureManager';
import { TilemapProgram, SpriteProgram, SpriteLitProgram } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import { DEPTH_TEST, PipelineMemo } from './pipelineCache';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { ViewProjection } from './viewProjection';
import type { ParticlePasses } from './particlePasses';
import { ShaderManager } from '../systems/shaderManager';
import { ModelDraw } from './modelDraw';
import type { RenderSubsystems } from './subsystems';
import { gatherParticleLocalLight } from '../particles/particleLighting';

import type { Material } from '../material';

/**
 * The nearest a local light is taken to be from a lit sprite's pixels (spriteLit.wgsl `lightRadius`): half
 * the placed quad's smaller world extent. A six-way or flat lit sprite is a billboard standing for a volume
 * of smoke about as deep as it is wide, so a light inside it lights that depth of medium, not the single
 * pixel it happens to sit on.
 */
export function spriteLightRadius(m: mat4): number {
    const width = Math.hypot(m[0], m[1], m[2]);
    const height = Math.hypot(m[4], m[5], m[6]);
    return 0.5 * Math.min(width, height);
}

/** What Sprite2DPasses reads from the renderer that owns it: its own state, not another subsystem's. */
export interface Sprite2DPassesHost {
    readonly canvas: HTMLCanvasElement;
    readonly thumbnailMode: boolean;
}

/**
 * Scales the 3×3 of a sprite's model matrix down so the quad it places draws at most `maxCssPx` tall in
 * `camera`: by view depth in perspective, by the view height in orthographic (2D zoom). CSS pixels
 * against the canvas's CSS height (`cssHeight`), so the cap does not move with the render scale.
 */
export function capSpriteScreenSize(m: mat4, maxCssPx: number, camera: Camera, cssHeight: number): void {
    const worldHeight = Math.hypot(m[4], m[5], m[6]);
    if (!cssHeight || worldHeight <= 0) return;
    let worldPerPx: number;
    if (camera.type === 'orthographic') {
        worldPerPx = Math.abs(camera.top - camera.bottom) / cssHeight;
    } else {
        const v = camera.viewMatrix;
        const depth = -(v[2] * m[12] + v[6] * m[13] + v[10] * m[14] + v[14]);
        if (depth <= camera.near) return;
        worldPerPx = 2 * depth * Math.tan(camera.fov * Math.PI / 360) / cssHeight;
    }
    const onScreen = worldHeight / worldPerPx;
    if (onScreen <= maxCssPx) return;
    const k = maxCssPx / onScreen;
    for (let i = 0; i < 12; i++) if (i % 4 !== 3) m[i] *= k;
}

/**
 * Sprites and the 2D pass: a sprite's billboard matrix and on-screen size cap, its draw, and the
 * Y-sorted pass that interleaves tilemap chunk bands, sprites and particles in a 2D scene. Split out
 * of Renderer.
 */
/** What an item of the 2D pass's draw list is. */
const KIND_SPRITE = 0, KIND_PARTICLES = 1, KIND_TILE = 2;
/** How a sprite composites, as a digit of its batch key: scene alpha, scene additive, editor overlay. */
const BLEND_ALPHA = 0, BLEND_ADDITIVE = 1, BLEND_OVERLAY = 2;
/** The batch key of a draw that is never merged: particles, tile bands, a lit sprite (for now). */
const NO_BATCH = -1;
/** Screen pixels every planner rectangle is padded by: what rasterization and jitter reach past the corners. */
const RECT_PAD_PX = 2;
/** A cull mode as a digit of the batch key. */
const CULL_DIGIT: Record<string, number> = { none: 0, back: 1, front: 2 };
/**
 * A side view's sprite depth key (Tilemap.entitySort 'none'): past every tile band's in the entity band, so
 * sprites draw over that layer's tiles. Far below where float64 loses a Z's worth of precision.
 */
const SIDE_VIEW_DEPTH = 1e9;

/** The highest sorting order of a particle system's emitters: where it sorts as one item. */
function emitterOrder(node: ParticleSystemNode): number {
    let order = 0;
    for (const e of node.system.emitters) order = Math.max(order, e.render.sortingOrder);
    return order;
}

/** `fresh`, holding `old`'s values: a list buffer grown in place of the old one. */
function grown<T extends Float32Array | Float64Array | Int32Array | Uint8Array>(old: T, fresh: T): T {
    fresh.set(old as ArrayLike<number>);
    return fresh;
}

/** No CPU-gathered local light: what a lit sprite takes when the cluster grid lights it per pixel. */
const NO_LOCAL_LIGHT = { fill: [0, 0, 0] as [number, number, number], keyDirection: [0, 1, 0] as [number, number, number],
                         keyColor: [0, 0, 0] as [number, number, number] };

export class Sprite2DPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: Sprite2DPassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _materials: MaterialBinder,
                private readonly _projection: ViewProjection,
                private readonly _particlePasses: ParticlePasses,
                private readonly _sys: RenderSubsystems) {}

    /**
     * The single depth-sorted 2D pass: tilemap chunks and sprites drawn in one interleaved order,
     * shared by the forward and deferred pipelines.
     *
     * Ordering is (band, depth) ascending. `band` is the layer's `order`, and sprites join the band of
     * the tilemap's nominated entity layer; `depth` is the negated world Y of the thing's BASE, so
     * something lower on screen draws in front. A scene with no tilemap sorts by camera distance.
     *
     * That order is the image. The draws themselves are BATCHED (graphics/spriteBatching.ts): sprites that
     * share a tileset, blend and sides go out as one instanced draw wherever the reordering it takes cannot
     * change a pixel, every per-sprite value riding in the sprite's object-table record.
     */
    public render2DPass(scene: Scene, target: RenderTarget = this._targets.scene.renderTarget): void {
        this._passTarget = target;
        this._beginList(target);
        // Scene content only. The editor's light/sound/probe icons are billboards in `scene.sprites`
        // too, and they belong to the overlay layer — see `EditorOverlays.renderEditorOverlay`. Not one
        // inside an occlusion volume the camera cannot see.
        for (const node of scene.sprites)
            if (node.visible && !isEditorOnlyNode(node) && !this._sys.visibility.volumeCulled(node)) this._addSprite(node, BLEND_ALPHA);

        const tilemaps: TilemapNode[] = [];
        for (const node of scene.tilemaps) if (node.visible) tilemaps.push(node);

        // Whether the scene's particles draw here rather than in their own pass (a 2D scene, or an
        // orthographic view over tilemaps): then they join the list, sorted with everything else.
        const particles = this._particlePasses.isFlatParticleScene(scene);

        // Selection outlines come from the mask pass, so there is no special-casing of the selected sprite here.
        // Before the pass opens: a chunk whose tiles changed rebuilds its mesh, an upload.
        if (tilemaps.length > 0) this._collectTilemapItems(scene, tilemaps, particles);
        else if (scene.dimension === '2D') this._collectFlatItems(scene);
        else {
            // A 3D scene: by sorting order (Sprite.sortingOrder), then back-to-front so blended sprites
            // composite correctly.
            const order = this._sortByOrderThenDistance();
            for (let p = 0; p < this._spriteCount; p++) this._pushItem(KIND_SPRITE, order[p]);
            // An orthographic view whose tilemaps are all hidden: its particles still draw, after the sprites.
            if (particles) for (const node of scene.particleSystems) {
                if (!node.visible || this._sys.visibility.volumeCulled(node)) continue;
                this._pushItem(KIND_PARTICLES, this._particleNodes.length);
                this._particleNodes.push(node);
            }
        }

        // One pass for the whole interleaved list. Every item's pipeline depth-tests without writing
        // depth, so 3D geometry still occludes the 2D layer and the 2D layer never occludes itself.
        const pass = this._begin2DPass();
        this._drawList(pass, scene, DEFAULT_BLEND, BLEND_ALPHA);
        this._passes.endFullscreenPass(pass);
    }

    /**
     * Batch sprites (the default). False draws every sprite alone through the per-sprite path, in the same
     * order and without the screen cull: an A/B switch for checking that batching changes no pixel.
     */
    public batching = true;

    /**
     * The editor's icons (lights, sounds, probes...), into the overlay pass `pass` is recording: batched like
     * the scene's sprites, in the order given, display-referred (the caller has set the pre-exposure to 1).
     */
    public drawOverlaySprites(nodes: readonly SpriteNode[], pass: RenderPassEncoder): void {
        const target = this._passes.target;
        if (!target || nodes.length === 0) return;
        this._beginList(target);
        for (const node of nodes) this._addSprite(node, BLEND_OVERLAY);
        for (let s = 0; s < this._spriteCount; s++) this._pushItem(KIND_SPRITE, s);
        this._drawList(pass, null, OVERLAY_BLEND, BLEND_OVERLAY);
    }

    /** The unit quad every batched sprite draws, position + uv (`vertex: 'model'`, built for `sprite`). */
    public get spriteQuad(): Mesh {
        if (!this._quad) {
            const quad = Geometry.Quad();
            this._quad = new Mesh().create(quad.getData(['position', 'uv']), quad.vertexCount, quad.indices);
        }
        return this._quad;
    }

    /**
     * Start a draw list for a pass on `target`: the raster projection the GPU will draw through (movie
     * jitter included), and the planner's rectangle padding in that target's NDC.
     */
    private _beginList(target: RenderTarget): void {
        this._spriteCount = 0;
        this._itemCount = 0;
        this._recordCount = 0;
        this._unsortedCount = 0;
        this._litGridState = -1;
        this._particleNodes.length = 0;
        this._tileCount = 0;
        const cam = this._view.camera;
        mat4.copy(this._rasterProj, this._projection.rasterProjection(cam.projectionMatrix));
        mat4.multiply(this._rectViewProj, this._rasterProj, cam.viewMatrix);
        this._padX = (2 * RECT_PAD_PX) / Math.max(1, target.width);
        this._padY = (2 * RECT_PAD_PX) / Math.max(1, target.height);
        void this.spriteQuad;   // built here, outside any pass, the first time
    }

    /**
     * Prepare `node` as the next sprite of the list: its billboarded (and screen-capped) matrix, its screen
     * rectangle and its batch key. A sprite that cannot reach the screen is left out.
     */
    private _addSprite(node: SpriteNode, blendClass: number): void {
        const s = this._spriteCount;
        this._growSprites(s + 1);
        const m = this._billboardInto(node, this._spriteMatrix);
        // SpriteNode.maxScreenSize: no taller than that many CSS pixels (the editor's viewport icons).
        if (node.maxScreenSize > 0)
            capSpriteScreenSize(m, node.maxScreenSize, this._view.camera, this._host.canvas.clientHeight);
        const state = quadClipRect(m, this._rectViewProj, this._padX, this._padY, this._spriteRects, s * 4);
        if (state === CLIP_RECT_CULLED && this.batching) return;
        this._spriteMatrices.set(m, s * 16);
        this._spriteBounded[s] = state === CLIP_RECT_BOUNDED ? 1 : 0;
        const sprite = node.sprite;
        // A scene sprite authored additive (fire, glows) adds its light; the overlay's icons never do.
        const additive = blendClass === BLEND_ALPHA && sprite.blend === 'additive';
        this._spriteAdditive[s] = additive ? 1 : 0;
        const blendDigit = additive ? BLEND_ADDITIVE : blendClass;
        // A lit sprite (Sprite.lit) draws with its own program and material; the overlay's icons are never lit.
        // Nor is anything in a flat 2D frame yet, which builds no 3D light grid for the lit program to read.
        const lit = blendClass !== BLEND_OVERLAY && sprite.lit && !this._view.flat2D;
        this._spriteLit[s] = lit ? 1 : 0;
        let key: number;
        if (lit) {
            // Kept in step with the sprite (its tint, sides and tileset's lighting maps) every frame.
            const material = sprite.drawMaterial();
            // Off the cluster grid (a thumbnail), a lit sprite takes its own CPU-gathered key light as
            // uniforms: it draws alone.
            key = this.batching && this._litGrid() ? this._litKey(material, blendDigit) : NO_BATCH;
        } else {
            key = this.batching ? this._unlitKey(sprite, blendDigit) : NO_BATCH;
        }
        this._spriteKeys[s] = key;
        this._spriteNodes[s] = node;
        this._spriteCount = s + 1;
    }

    /**
     * Whether this pass's lit sprites light every local light per pixel through the frame's cluster grid
     * (spriteLit.wgsl `localLights`), decided once per pass: the lit program binds it, and the frame is not
     * a thumbnail (whose grid is not the scene's). Off it, each takes its strongest local light from the CPU.
     */
    private _litGrid(): boolean {
        if (this._litGridState < 0) {
            const pipeline = this._pipelines.memoized(this._memo, this, 'spriteLit', SpriteLitProgram, {
                cullMode: 'none', depthStencil: DEPTH_TEST, blend: DEFAULT_BLEND, vertex: 'model', builtFor: 'sprite',
                target: this._passTarget ?? this._targets.scene.renderTarget,
            });
            this._litGridState = this._bindGroups.declaresFrameLighting(pipeline) && !this._host.thumbnailMode
                && !this._view.capturing ? 1 : 0;
        }
        return this._litGridState === 1;
    }

    /**
     * {@link _unlitKey} for a lit sprite's draw material: its three maps (colour, six-way positive or normal,
     * six-way negative or ORM) and lighting mode, as one combination id, plus the same sides, wireframe and
     * blend digits, tagged lit so a lit and an unlit sprite never share a draw.
     */
    private _litKey(material: Material, blendClass: number): number {
        const combo = `${material.textures.get('texture') ?? ''}|${material.textures.get('mapA') ?? ''}|`
            + `${material.textures.get('mapB') ?? ''}|${material.properties.get('mode') ?? 0}|`
            + `${material.properties.get('hasOrm') ? 1 : 0}|${material.properties.get('hasTexture') ? 1 : 0}`;
        let id = this._litCombos.get(combo) ?? 0;
        if (id === 0) this._litCombos.set(combo, id = this._litCombos.size + 1);
        const cull = CULL_DIGIT[ModelDraw.cullFor(material.config.side)];
        const wire = material.config.wireframe ? 1 : 0;
        return ((((id * 2 + wire) * 3 + cull) * 3 + blendClass) * 2) + 1;
    }

    /**
     * Everything that has to match for two unlit sprites to share a draw: the texture their material binds
     * (by id: within one frame an id names one texture, which is what the batch's bind group resolves it to),
     * whether there is one, the sides, the wireframe and the blend. Whatever else differs rides in the
     * instance (objectData.ts `packSpriteRecord`).
     */
    private _unlitKey(sprite: Sprite, blendClass: number): number {
        const material = sprite.material;
        const id = material.textures.get('texture');
        let tex = 0;
        if (id) {
            tex = this._textureIds.get(id) ?? 0;
            if (tex === 0) this._textureIds.set(id, tex = ++this._nextTextureId);
        }
        const hasTexture = material.properties.get('hasTexture') ? 1 : 0;
        const cull = CULL_DIGIT[ModelDraw.cullFor(material.config.side)];
        const wire = material.config.wireframe ? 1 : 0;
        return ((((tex * 2 + hasTexture) * 2 + wire) * 3 + cull) * 3 + blendClass) * 2;
    }

    /**
     * The list's sprites by ascending sorting order (higher on top, whatever the distances say, as Unreal's
     * translucency sort priority), and within one farthest from the camera first; stable for equal distances.
     */
    private _sortByOrderThenDistance(): Int32Array {
        const n = this._spriteCount;
        this._growSort(n);
        const keys = this._sortKeys, orders = this._sortBands, eye = this._view.camera.position;
        // Each distance once, negated so ascending is farthest first: the same `vec3.distance` values in a
        // stable order are the order the comparator sort `dist(b) - dist(a)` gave, ties included. With every
        // sorting order 0 (the default) it is exactly that order.
        for (let s = 0; s < n; s++) {
            const node = this._spriteNodes[s];
            keys[s] = -vec3.distance(eye, node.worldPosition);
            orders[s] = node.sprite.sortingOrder;
        }
        return this._argsort.byBandThenDepth(orders, keys, n, this._sortIndex);
    }

    /**
     * A 2D scene with no tilemap: its sprites and particle systems by sorting order, then by depth along the
     * view -- farther first -- and then in scene order. Depth is the world Z (what a 2D scene stacks along),
     * signed by the way the camera faces it: a camera's view direction is never exactly along Z in floating
     * point, and a distance or a full view depth would order two sprites at the same Z by how far from the
     * centre of the screen they stand.
     */
    private _collectFlatItems(scene: Scene): void {
        const sign = this._view.camera.viewMatrix[10] >= 0 ? 1 : -1;
        for (let s = 0; s < this._spriteCount; s++) {
            const node = this._spriteNodes[s];
            this._pushUnsorted(KIND_SPRITE, s, node.sprite.sortingOrder, sign * node.worldPosition[2]);
        }
        for (const node of scene.particleSystems) {
            if (!node.visible || this._sys.visibility.volumeCulled(node)) continue;
            this._pushUnsorted(KIND_PARTICLES, this._particleNodes.length, emitterOrder(node), sign * node.worldPosition[2]);
            this._particleNodes.push(node);
        }
        this._sortUnsorted();
    }

    /** The collected list in (band, depth) order, stable, into the draw list. */
    private _sortUnsorted(): void {
        const n = this._unsortedCount;
        this._growSort(n);
        const order = this._argsort.byBandThenDepth(this._unsortedBand, this._unsortedDepth, n, this._sortIndex);
        for (let p = 0; p < n; p++) this._pushItem(this._unsortedKind[order[p]], this._unsortedRef[order[p]]);
    }

    private _growSort(n: number): void {
        if (this._sortKeys.length >= n) return;
        const size = Math.max(64, n + (n >> 1));
        this._sortKeys = new Float64Array(size);
        this._sortBands = new Float64Array(size);
        this._sortIndex = new Int32Array(size);
    }

    /**
     * A scene with tilemaps: its sprites, particle systems and visible tile chunks (or their depth bands) as
     * one list, in (band, depth) order. Ties keep that insertion order (the sort is stable), as they always did.
     */
    private _collectTilemapItems(scene: Scene, tilemaps: readonly TilemapNode[], particles: boolean): void {
        // Sprites join the first tilemap's entity layer. With several tilemaps in one scene the first
        // one wins rather than the pass guessing — a scene that needs different bands per region should
        // say so by ordering its layers, not by which map happened to be traversed first.
        const host = tilemaps[0].tilemap;
        const entityBand = host.layers[host.entityLayer]?.cfg.order ?? 0;
        // A side view (Tilemap.entitySort 'none') puts its sprites and particles over the entity layer's
        // tiles, then in sorting order and Z, then scene order: the depth key past every tile's (a tile
        // band's is at most its row's -Y, a layer's 0), plus the signed Z as `_collectFlatItems` takes it.
        const sideView = host.entitySort === 'none';
        const zSign = this._view.camera.viewMatrix[10] >= 0 ? 1 : -1;
        for (let s = 0; s < this._spriteCount; s++) {
            const sprite = this._spriteNodes[s];
            // The sprite's BASE, not its centre: a character's feet are what sorts against a trunk row. Its
            // sorting order offsets its band, as an emitter's does below.
            const depth = sideView ? SIDE_VIEW_DEPTH + zSign * sprite.worldPosition[2] : -this._baseY(sprite);
            this._pushUnsorted(KIND_SPRITE, s, entityBand + sprite.sprite.sortingOrder, depth);
        }
        // Particle systems sort as one item by their emitter's Y, like a sprite's base, in the entity
        // band offset by the highest emitter sorting order — so "in front of the player" is authored,
        // not an accident of traversal. Only where they draw here: a perspective view over a tilemap
        // draws them in their own pass, and drew them twice when this took them too.
        if (particles) for (const node of scene.particleSystems) {
            if (!node.visible || this._sys.visibility.volumeCulled(node)) continue;
            const depth = sideView ? SIDE_VIEW_DEPTH + zSign * node.worldPosition[2] : -node.worldPosition[1];
            this._pushUnsorted(KIND_PARTICLES, this._particleNodes.length, entityBand + emitterOrder(node), depth);
            this._particleNodes.push(node);
        }

        for (const node of tilemaps) {
            const tilemap = node.tilemap;
            for (let i = 0; i < tilemap.layers.length; i++) {
                const layer = tilemap.layers[i];
                if (!layer.cfg.visible || layer.cfg.opacity <= 0) continue;
                const tileset = tilemap.tilesetOf(i);
                if (!tileset) continue;

                for (const chunk of layer.chunks.values()) {
                    if (chunk.count === 0) continue;
                    if (!this._chunkVisible(tilemap, layer, chunk, node.worldPosition)) continue;
                    frameStats.tilemapChunks++;

                    if (!chunk.mesh) chunk.mesh = new TileMesh();
                    if (chunk.meshDirty) {
                        chunk.mesh.build(chunk, layer, tileset, tilemap.grid, tilemap.time);
                        chunk.meshDirty = false;
                    } else if (chunk.animated) {
                        chunk.mesh.patchAnimatedUVs(tileset, tilemap.time);
                    }

                    if (layer.cfg.ySorted) {
                        for (const b of chunk.mesh.bands)
                            this._pushUnsorted(KIND_TILE, this._addTile(node, layer, chunk, b, b.indexOffset, b.indexCount),
                                               layer.cfg.order, -b.sortY);
                    } else {
                        // One band on a layer that is not Y-sorted, covering every tile: its bounds are the chunk's.
                        const all = chunk.mesh.bands[0] ?? null;
                        this._pushUnsorted(KIND_TILE, this._addTile(node, layer, chunk, all, 0, chunk.mesh.indexCount),
                                           layer.cfg.order, 0);
                    }
                }
            }
        }

        this._sortUnsorted();
    }

    /** Remember one tile draw (a chunk, or one of its depth bands) and return its slot. */
    private _addTile(node: TilemapNode, layer: TilemapLayer, chunk: TileChunk, band: DepthBand | null,
                     indexOffset: number, indexCount: number): number {
        const t = this._tileCount++;
        this._tileNodes[t] = node;
        this._tileLayers[t] = layer;
        this._tileChunks[t] = chunk;
        this._tileBands[t] = band;
        this._tileOffsets[t] = indexOffset;
        this._tileCounts[t] = indexCount;
        return t;
    }

    private _pushUnsorted(kind: number, ref: number, band: number, depth: number): void {
        const i = this._unsortedCount++;
        if (i >= this._unsortedKind.length) {
            const size = Math.max(64, (i + 1) * 2);
            this._unsortedKind = grown(this._unsortedKind, new Uint8Array(size));
            this._unsortedRef = grown(this._unsortedRef, new Int32Array(size));
            this._unsortedBand = grown(this._unsortedBand, new Float64Array(size));
            this._unsortedDepth = grown(this._unsortedDepth, new Float64Array(size));
        }
        this._unsortedKind[i] = kind;
        this._unsortedRef[i] = ref;
        this._unsortedBand[i] = band;
        this._unsortedDepth[i] = depth;
    }

    /** Append one item to the list in its final draw order. */
    private _pushItem(kind: number, ref: number): void {
        const i = this._itemCount++;
        if (i >= this._itemKind.length) {
            const size = Math.max(64, (i + 1) * 2);
            this._itemKind = grown(this._itemKind, new Uint8Array(size));
            this._itemRef = grown(this._itemRef, new Int32Array(size));
            this._itemKeys = grown(this._itemKeys, new Int32Array(size));
            this._itemAdditive = grown(this._itemAdditive, new Uint8Array(size));
        }
        this._itemKind[i] = kind;
        this._itemRef[i] = ref;
        const sprite = kind === KIND_SPRITE;
        this._itemKeys[i] = sprite ? this._spriteKeys[ref] : NO_BATCH;
        this._itemAdditive[i] = sprite ? this._spriteAdditive[ref] : 0;
        if (sprite) this._recordCount++;
    }

    /**
     * Draw the list into `pass`: plan the batches, give every sprite its record (contiguous per batch, in
     * draw order), then walk the batches. A sprite that never merges is a batch of one. `scene` is null for
     * the overlay's icons (no particles).
     */
    private _drawList(pass: RenderPassEncoder, scene: Scene | null, blend: BlendState, blendClass: number): void {
        const count = this._itemCount;
        if (count === 0) return;
        const planner = this._planner;
        const runs = planner.plan(count, this._itemKeys, this._itemAdditive, this._boundsOf);
        const order = planner.order;

        const objects = this._sys.objects;
        let record = 0;
        if (this._recordCount > 0) {
            // Claimed, then filled before anything else can append: every batch's records are contiguous.
            record = objects.appendRun(this._recordCount);
            const staging = objects.staging;
            let r = record;
            for (let p = 0; p < count; p++) {
                const item = order[p];
                if (this._itemKind[item] !== KIND_SPRITE) continue;
                this._packSprite(staging, r++ * OBJECT_RECORD_FLOATS, this._itemRef[item], blendClass);
            }
        }

        for (let b = 0; b < runs; b++) {
            const item = order[planner.runStart[b]];
            const ref = this._itemRef[item];
            const kind = this._itemKind[item];
            if (kind === KIND_SPRITE) {
                const n = planner.runCount[b];
                this._drawSpriteBatch(pass, ref, record, n, blend, blendClass);
                record += n;
            } else if (kind === KIND_PARTICLES) {
                this._particlePasses.particles.draw([this._particleNodes[ref]], this._particlePasses.particleDrawFrame(scene!, pass, this._passTarget ?? this._targets.scene.renderTarget));
            } else {
                this._drawTileBand(this._tileNodes[ref], this._tileLayers[ref], this._tileChunks[ref],
                                   this._tileOffsets[ref], this._tileCounts[ref], pass);
            }
        }
    }

    /** One batched sprite's record (objectData.ts `packSpriteRecord`): everything about it that may differ. */
    private _packSprite(out: Float32Array, offset: number, s: number, blendClass: number): void {
        const node = this._spriteNodes[s];
        const sprite = node.sprite;
        // Soft fade (Sprite.softness): the sprite keeps the plain depth test -- whatever stands in front of it
        // hides it, a torch head seen from below included -- and fades out over `softness` metres as it nears
        // the opaque surface BEHIND it (chunks/spriteForward.wgsl, against the scene's depth snapshot), so a
        // flame set into its torch head or logs melts into them instead of being cut along a line. Off where
        // there is no live snapshot (a thumbnail, the overlay's icons).
        const soft = blendClass !== BLEND_OVERLAY && !this._host.thumbnailMode && !this._view.flat2D ? sprite.softness : 0;
        // From the tile on screen: an animated sprite follows its frame's overdrive. A sprite that takes less
        // than the whole exposure (Sprite.exposureWeight) is divided by the rest of it here; the tonemapper
        // multiplies by all. A sprite that burns with a light (Sprite.followLight) swells and dims on the
        // light's own beat.
        const weight = sprite.exposureWeight;
        const drive = node.overdrive * node.lightFollowScale;
        const intensity = weight < 1 && this._view.exposure > 0 ? drive * Math.pow(this._view.exposure, weight - 1) : drive;
        const ambient = this._spriteLit[s] ? this._litAmbient(node, s) : null;
        // A mirrored sprite reads its tile backwards along the flipped axis (the pivot mirrored with it in the
        // matrix, SpriteNode.quadMatrixInto): the record's UV scale goes negative and the shader needs no word.
        const uv = node.uvRectInto(this._uv);
        if (sprite.flipX) { const u = uv[0]; uv[0] = uv[2]; uv[2] = u; }
        if (sprite.flipY) { const v = uv[1]; uv[1] = uv[3]; uv[3] = v; }
        packSpriteRecord(out, offset, this._spriteMatrices, s * 16, dissolveOf(node.effectiveFade), uv,
                         soft, sprite.tint, sprite.opacity, intensity, ambient);
        frameStats.objects++;
        frameStats.spritesDrawn++;
    }

    /**
     * A lit sprite's fill where it stands, into its record: a light probe's in its volume (a room's smoke is lit
     * by the room), else the scene ambient and sky light (render/probeLighting.ts). Off the cluster grid the
     * local lights past the strongest one join it, through the 1/π, as lit particles take them, and the
     * strongest is kept for the sprite's own draw (`_litKeyLight`).
     */
    private _litAmbient(node: SpriteNode, s: number): ArrayLike<number> {
        const out = this._litAmbientOut;
        const scene = node.scene;
        const key = this._litKeyLight, k = s * 6;
        for (let i = 0; i < 6; i++) key[k + i] = i === 1 ? 1 : 0;
        if (!scene) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
        const light = this._particlePasses.frameLight(scene);
        const m = this._spriteMatrices, at = s * 16;
        vec3.set(this._litPos, m[at + 12], m[at + 13], m[at + 14]);
        const ambient = this._sys.lighting.probeAmbientAt(scene, this._litPos, light.ambient, this._litScratch);
        out[0] = ambient[0]; out[1] = ambient[1]; out[2] = ambient[2];
        if (!this._litGrid()) {
            const local = gatherParticleLocalLight([this._litPos[0], this._litPos[1], this._litPos[2]], light.localLights);
            out[0] += local.fill[0] / Math.PI; out[1] += local.fill[1] / Math.PI; out[2] += local.fill[2] / Math.PI;
            key[k] = local.keyDirection[0]; key[k + 1] = local.keyDirection[1]; key[k + 2] = local.keyDirection[2];
            key[k + 3] = local.keyColor[0]; key[k + 4] = local.keyColor[1]; key[k + 5] = local.keyColor[2];
        }
        return out;
    }

    /**
     * One instanced draw of `count` sprites, records `first`.. on, led by sprite slot `s` (every member shares
     * its key, so its program and material state). The order of the calls is WebGL2's: `setPipeline` there
     * neither binds the program the uniform writes go to nor keeps texture units, so the program is bound
     * first and the groups set after.
     */
    private _drawSpriteBatch(pass: RenderPassEncoder, s: number, first: number, count: number,
                             blend: BlendState, blendClass: number): void {
        const lead = this._spriteNodes[s];
        const lit = this._spriteLit[s] === 1;
        const program = lit ? 'spriteLit' : 'sprite';
        // A lit sprite's draw material was re-synced when it joined the list.
        const material = lit ? lead.sprite.drawMaterial() : lead.sprite.material;
        this._shaderManager.bind(program);
        const pipeline = this._pipelines.memoized(this._memo, material, program, lit ? SpriteLitProgram : SpriteProgram, {
            cullMode: ModelDraw.cullFor(material.config.side),
            depthStencil: DEPTH_TEST,
            // DEFAULT_BLEND for a scene sprite (its alpha must not touch the bloom mask), OVERLAY_BLEND for an
            // editor icon drawn into the overlay layer, where alpha IS coverage.
            blend: this._spriteAdditive[s] ? SPRITE_ADDITIVE_BLEND : blend,
            topology: material.config.wireframe ? 'line-list' : 'triangle-list',
            vertex: 'model',
            builtFor: 'sprite',
        });
        pass.setPipeline(pipeline);

        const cam = this._view.camera;
        this._shaderManager.setUniform('u_view', cam.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._rasterProj);
        // The despawn dither's phase; how far gone each sprite is rides in its record.
        this._materials.setDissolve(0, false);
        // The per-batch values go INTO the lead's properties: MaterialSync skips a repeat write by material,
        // so a write past `applyProperties` would leave its memo describing a block it no longer matches.
        // No live snapshot in a thumbnail, for the overlay's icons, or in a flat 2D frame (which takes none).
        const live = blendClass !== BLEND_OVERLAY && !this._host.thumbnailMode && !this._view.flat2D ? 1 : 0;
        material.properties.set('depthParams', [cam.near, cam.far, cam.type === 'orthographic' ? 1 : 0, live]);
        const grid = lit && this._litGrid();
        if (lit) this._setBatchLight(lead, material, s, grid);
        if (grid) this._sys.lighting.lightGrid.uploadUniforms(this._shaderManager);
        this._materials.applyProperties(material);
        pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
        if (lit && this._bindGroups.declaresShadowGroup(pipeline)) {
            // The key light's cascades: a lit sprite takes the shadows the sun casts on it. Once per batch.
            this._sys.shadows.uploadShadowUniforms('spriteLit');
            pass.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline, false));
        }
        // Anything appended since is uploaded, and a grown table rebinds.
        const objects = this._sys.objects;
        objects.flush();
        pass.setBindGroup(2, this._bindGroups.objectDataGroup(pipeline, objects.texture));
        this._passes.recordDrawInstances(pass, this.spriteQuad, count, first);
        frameStats.spriteDraws++;
    }

    /**
     * A lit batch's light, the same for every sprite in it (lit particles take it alike, render/particlePasses.ts):
     * the frame's key light, whether the cluster grid lights the local lights per pixel, and, off it, the lead's
     * own strongest local light (a batch of one there). Each sprite's frame -- right, up and back, the frame the
     * Creator bakes six-way lightmaps and normals in -- and its light radius come from its matrix in the shader;
     * its fill rides in its record.
     */
    private _setBatchLight(lead: SpriteNode, material: Material, s: number, grid: boolean): void {
        material.properties.set('gridLights', grid ? 1 : 0);
        const scene = lead.scene;
        if (!scene) {
            material.properties.set('sunColor', [0, 0, 0]);
            material.properties.set('keyColor', [0, 0, 0]);
            return;
        }
        const light = this._particlePasses.frameLight(scene);
        material.properties.set('sunDir', [light.sunDirection[0], light.sunDirection[1], light.sunDirection[2]]);
        material.properties.set('sunColor', [light.sunColor[0], light.sunColor[1], light.sunColor[2]]);
        const key = this._litKeyLight, k = s * 6;
        material.properties.set('keyDir', grid ? NO_LOCAL_LIGHT.keyDirection : [key[k], key[k + 1], key[k + 2]]);
        material.properties.set('keyColor', grid ? NO_LOCAL_LIGHT.keyColor : [key[k + 3], key[k + 4], key[k + 5]]);
    }

    /** The planner's view of an item's screen rectangle (graphics/spriteBatching.ts). */
    private readonly _boundsOf: BatchBoundsFn = (item, out, offset) => {
        const ref = this._itemRef[item];
        const kind = this._itemKind[item];
        if (kind === KIND_SPRITE) {
            if (!this._spriteBounded[ref]) return false;
            const r = this._spriteRects, at = ref * 4;
            out[offset] = r[at]; out[offset + 1] = r[at + 1]; out[offset + 2] = r[at + 2]; out[offset + 3] = r[at + 3];
            return true;
        }
        if (kind === KIND_TILE) return this._tileRect(ref, out, offset);
        return false;   // a particle system: its extent is the simulation's, not known here
    };

    /**
     * A tile draw's screen rectangle: its band's map-local bounds, moved exactly as `_drawTileBand`'s model
     * matrix moves the chunk (node origin, parallax, layer z offset). Off screen it is an empty rectangle at
     * infinity, which overlaps nothing.
     */
    private _tileRect(t: number, out: Float64Array, offset: number): boolean {
        const band = this._tileBands[t];
        if (!band || !(band.minX <= band.maxX)) return false;
        const layer = this._tileLayers[t];
        const cam = this._view.camera.position;
        const origin = this._tileNodes[t].worldPosition;
        const ox = origin[0] + cam[0] * (1 - layer.cfg.parallax[0]);
        const oy = origin[1] + cam[1] * (1 - layer.cfg.parallax[1]);
        const oz = origin[2] + layer.cfg.zOffset;
        const state = boxClipRect(band.minX + ox, band.minY + oy, oz, band.maxX + ox, band.maxY + oy, oz,
                                  this._rectViewProj, this._padX, this._padY, out, offset);
        if (state === CLIP_RECT_CULLED) {
            out[offset] = out[offset + 1] = out[offset + 2] = out[offset + 3] = Infinity;
            return true;
        }
        return state === CLIP_RECT_BOUNDED;
    }

    private _growSprites(n: number): void {
        if (n <= this._spriteKeys.length) return;
        const size = Math.max(64, n * 2);
        this._spriteMatrices = grown(this._spriteMatrices, new Float32Array(size * 16));
        this._spriteRects = grown(this._spriteRects, new Float64Array(size * 4));
        this._spriteBounded = grown(this._spriteBounded, new Uint8Array(size));
        this._spriteKeys = grown(this._spriteKeys, new Int32Array(size));
        this._spriteAdditive = grown(this._spriteAdditive, new Uint8Array(size));
        this._spriteLit = grown(this._spriteLit, new Uint8Array(size));
        this._litKeyLight = grown(this._litKeyLight, new Float64Array(size * 6));
    }

    // --- The draw list: reused pass to pass, its buffers only grow ------------------------------------
    private readonly _planner = new SpriteBatchPlanner();
    private readonly _memo = new PipelineMemo();
    private _quad: Mesh | null = null;
    private readonly _textureIds = new Map<string, number>();
    private _nextTextureId = 0;
    private readonly _uv = new Float32Array(4);
    private readonly _rasterProj = mat4.create();
    private readonly _rectViewProj = mat4.create();
    private _padX = 0;
    private _padY = 0;
    // Sprites, by slot.
    private _spriteCount = 0;
    private readonly _spriteNodes: SpriteNode[] = [];
    private _spriteMatrices = new Float32Array(0);
    private _spriteRects = new Float64Array(0);
    private _spriteBounded = new Uint8Array(0);
    private _spriteKeys = new Int32Array(0);
    private _spriteAdditive = new Uint8Array(0);
    private _spriteLit = new Uint8Array(0);
    /** Per lit sprite off the cluster grid: its strongest local light, direction then colour. */
    private _litKeyLight = new Float64Array(0);
    private readonly _litCombos = new Map<string, number>();
    /** -1 not yet decided this pass, else 0/1: see `_litGrid`. */
    private _litGridState = -1;
    private readonly _litPos = vec3.create();
    private readonly _litScratch: number[] = [0, 0, 0];
    private readonly _litAmbientOut: number[] = [0, 0, 0];
    // Particle systems and tile draws, by slot.
    private readonly _particleNodes: ParticleSystemNode[] = [];
    private _tileCount = 0;
    private readonly _tileNodes: TilemapNode[] = [];
    private readonly _tileLayers: TilemapLayer[] = [];
    private readonly _tileChunks: TileChunk[] = [];
    private readonly _tileBands: (DepthBand | null)[] = [];
    private readonly _tileOffsets: number[] = [];
    private readonly _tileCounts: number[] = [];
    // The list before its (band, depth) sort, and after it.
    private _unsortedCount = 0;
    private _unsortedKind = new Uint8Array(0);
    private _unsortedRef = new Int32Array(0);
    private _unsortedBand = new Float64Array(0);
    private _unsortedDepth = new Float64Array(0);
    private _itemCount = 0;
    /** Sprites in the list: each gets a record. */
    private _recordCount = 0;
    private _itemKind = new Uint8Array(0);
    private _itemRef = new Int32Array(0);
    private _itemKeys = new Int32Array(0);
    private _itemAdditive = new Uint8Array(0);
    private readonly _argsort = new StableArgsort();
    private _sortKeys = new Float64Array(0);
    private _sortBands = new Float64Array(0);
    private _sortIndex = new Int32Array(0);

    /** The target this frame's 2D pass draws into (`render2DPass`). */
    private _passTarget: RenderTarget | undefined = undefined;

    /** Open the pass the tiles and sprites share. Loads and stores: this draws over the composited scene. */
    private _begin2DPass(): RenderPassEncoder {
        return this._passes.beginFullscreenPass(this._passTarget ?? this._targets.scene.renderTarget, '2d', false, undefined, false);
    }

    /** Frustum test for one chunk, in world space. `origin` is the owning node's world position. */
    private _chunkVisible(tilemap: Tilemap, layer: TilemapLayer, chunk: TileChunk, origin: vec3): boolean {
        if (!this._sys.visibility.frustumCulling) return true;
        // A parallaxed layer is drawn at a camera-dependent offset, so its world box moves with the
        // camera; culling it against the un-offset box would pop tiles in and out at the screen edge.
        if (layer.cfg.parallax[0] !== 1 || layer.cfg.parallax[1] !== 1) return true;
        const g = tilemap.grid;
        // Local cell math plus the node's world position, matching how the mesh is built and drawn —
        // `tilemap.cellToWorld` would fold in the map's own origin, which is only refreshed by the
        // per-frame update the editor never runs.
        const c0 = cellToWorld(g, chunk.cx * CHUNK_SIZE, chunk.cy * CHUNK_SIZE);
        const c1 = cellToWorld(g, (chunk.cx + 1) * CHUNK_SIZE, (chunk.cy + 1) * CHUNK_SIZE);
        // Isometric chunks are diamonds, so their axis-aligned extent runs to the opposite corners too;
        // padding by the chunk's own width keeps the test conservative for every grid kind.
        const padX = CHUNK_SIZE * g.cellWidth, padY = CHUNK_SIZE * g.cellHeight;
        const min = [origin[0] + Math.min(c0[0], c1[0]) - padX, origin[1] + Math.min(c0[1], c1[1]) - padY, origin[2] - 1];
        const max = [origin[0] + Math.max(c0[0], c1[0]) + padX, origin[1] + Math.max(c0[1], c1[1]) + padY, origin[2] + 1];
        return this._sys.visibility.frustum.intersectsAABB(min, max);
    }

    private _drawTileBand(node: TilemapNode, layer: TilemapLayer, chunk: TileChunk,
                          indexOffset: number, indexCount: number,
                          pass?: RenderPassEncoder): void {
        const tilemap = node.tilemap;
        const tileset = tilemap.tilesetById(layer.cfg.tilesetId);
        if (!tileset || !chunk.mesh || indexCount <= 0) return;

        // The pipeline binds the program, but the uniforms below are written by name into the bound
        // program's block, so it still has to be current before them.
        if (!pass || !chunk.mesh.vertexBuffer || !chunk.mesh.indexBuffer) return;
        const pipeline = this._pipelines.get('tilemap', TilemapProgram, {
            // Blended, depth-tested against the 3D scene, no depth writes (tiles are sorted, and a
            // written depth would occlude the band drawn after).
            cullMode: 'none',
            depthStencil: DEPTH_TEST,
            blend: DEFAULT_BLEND,
            vertex: 'tile',
        });
        pass.setPipeline(pipeline);
        this._shaderManager.bind('tilemap');
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));

        // Chunk meshes are in MAP-LOCAL space, so the node's world position belongs here — read off the
        // node, not `tilemap.origin`, which is stale until the scene ticks. Parallax and the layer z
        // offset ride in this matrix and ONLY here, never on the node's transform.
        const cam = this._view.camera.position;
        const origin = node.worldPosition;
        const model = this._tileModel;
        mat4.identity(model);
        model[12] = origin[0] + cam[0] * (1 - layer.cfg.parallax[0]);
        model[13] = origin[1] + cam[1] * (1 - layer.cfg.parallax[1]);
        model[14] = origin[2] + layer.cfg.zOffset;
        this._shaderManager.setUniform('u_model', model);
        this._shaderManager.setUniform('u_preExposure', this._view.drawPreExposure);

        const texture = TextureManager.Instance.getTexture(tileset.textureId)
            || TextureManager.Instance.getTexture('Null');
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [texture ?? this._bindGroups.fallbackTexture]));
        pass.setVertexBuffer(0, chunk.mesh.vertexBuffer);
        pass.setIndexBuffer(chunk.mesh.indexBuffer, 'uint16');
        pass.drawIndexed(indexCount, 1, indexOffset);
        frameStats.tilemapDraws++;
        frameStats.objects++;
    }

    /** Builds a sprite's world matrix with its camera-facing billboard constraint applied (render/billboard.ts). */
    public spriteBillboardMatrix(node: SpriteNode): mat4 {
        return this._billboardInto(node, mat4.create());
    }

    /** {@link spriteBillboardMatrix} into `out`: the per-draw path's pooled matrix. */
    private _billboardInto(node: SpriteNode, out: mat4): mat4 {
        const cam = this._view.camera;
        return node.quadMatrixInto(out, cam);
    }

    /**
     * The world Y of a sprite's BASE, the bottom edge of its image: what a Y-sorted map orders it by. Its
     * origin less the share of its height below the pivot, so a character pivoted at its feet sorts by
     * where it stands; a centred unit sprite by its centre less half its scale, as it always did.
     */
    private _baseY(node: SpriteNode): number {
        const sprite = node.sprite;
        const size = sprite.quadSize(node.currentTile, this._quadSize);
        const py = sprite.flipY ? 1 - sprite.pivot[1] : sprite.pivot[1];
        return node.worldPosition[1] - py * size[1] * node.worldScale[1];
    }
    private readonly _quadSize: [number, number] = [1, 1];

    private readonly _spriteMatrix = mat4.create();
    /** A tile band's model matrix, rewritten per draw. */
    private readonly _tileModel = mat4.create();
}
