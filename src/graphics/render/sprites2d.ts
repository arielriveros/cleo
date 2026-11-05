import { vec3, mat4 } from 'gl-matrix';
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
import { gl } from '../glContext';
import { frameStats } from '../renderStats';
import type { RenderPassEncoder } from '../rhi/device';
import { DEFAULT_BLEND, SPRITE_ADDITIVE_BLEND, OVERLAY_BLEND } from '../rhi/types';
import type { BlendState, CullMode } from '../rhi/types';
import { GLState } from '../systems/glState';
import { TextureManager } from '../systems/textureManager';
import { TilemapProgram, FORWARD_PROGRAMS } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import { DEPTH_TEST } from './pipelineCache';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { ViewProjection } from './viewProjection';
import type { ParticlePasses } from './particlePasses';
import { ShaderManager } from '../systems/shaderManager';

/** What Sprite2DPasses reads from the renderer that owns it, while those members still live there. */
export interface Sprite2DPassesHost {
    readonly canvas: HTMLCanvasElement;
    cullFor(side: 'front' | 'back' | 'double' | undefined): CullMode;
    readonly frustum: Frustum;
    readonly frustumCulling: boolean;
    restoreDefaultBlend(): void;
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
                private readonly _particlePasses: ParticlePasses) {}

    /**
     * The single depth-sorted 2D pass: tilemap chunks and sprites drawn in one interleaved order,
     * shared by the forward and deferred pipelines.
     *
     * Ordering is (band, depth) ascending. `band` is the layer's `order`, and sprites join the band of
     * the tilemap's nominated entity layer; `depth` is the negated world Y of the thing's BASE, so
     * something lower on screen draws in front. A scene with no tilemap sorts by camera distance.
     */
    public render2DPass(scene: Scene): void {
        const sprites: SpriteNode[] = [];
        // Scene content only. The editor's light/sound/probe icons are billboards in `scene.sprites`
        // too, and they belong to the overlay layer — see `EditorOverlays.renderEditorOverlay`.
        for (const node of scene.sprites) if (node.visible && !isEditorOnlyNode(node)) sprites.push(node);

        const tilemaps: TilemapNode[] = [];
        for (const node of scene.tilemaps) if (node.visible) tilemaps.push(node);

        if (tilemaps.length === 0) {
            // Back-to-front so blended sprites composite correctly. Selection outlines come from the
            // mask pass, so there is no special-casing of the selected sprite here.
            sprites.sort((a, b) =>
                vec3.distance(this._view.camera.position, b.worldPosition) -
                vec3.distance(this._view.camera.position, a.worldPosition));
            const only = this._begin2DPass();
            for (const node of sprites) this.renderSprite(node, true, only);
            this._passes.endFullscreenPass(only);
            return;
        }

        type Draw2D =
            | { band: number; depth: number; sprite: SpriteNode }
            | { band: number; depth: number; particles: ParticleSystemNode }
            | { band: number; depth: number; node: TilemapNode; layer: TilemapLayer; chunk: TileChunk;
                indexOffset: number; indexCount: number };
        const list: Draw2D[] = [];

        // Sprites join the first tilemap's entity layer. With several tilemaps in one scene the first
        // one wins rather than the pass guessing — a scene that needs different bands per region should
        // say so by ordering its layers, not by which map happened to be traversed first.
        const host = tilemaps[0].tilemap;
        const entityBand = host.layers[host.entityLayer]?.cfg.order ?? 0;
        for (const sprite of sprites) {
            // The sprite's BASE, not its centre: a character's feet are what sorts against a trunk row.
            const base = sprite.worldPosition[1] - sprite.worldScale[1] * 0.5;
            list.push({ band: entityBand, depth: -base, sprite });
        }
        // Particle systems sort as one item by their emitter's Y, like a sprite's base, in the entity
        // band offset by the highest emitter sorting order — so "in front of the player" is authored,
        // not an accident of traversal.
        for (const particles of scene.particleSystems) {
            if (!particles.visible) continue;
            let order = 0;
            for (const e of particles.system.emitters) order = Math.max(order, e.render.sortingOrder);
            list.push({ band: entityBand + order, depth: -particles.worldPosition[1], particles });
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
                            list.push({ band: layer.cfg.order, depth: -b.sortY, node, layer, chunk,
                                        indexOffset: b.indexOffset, indexCount: b.indexCount });
                    } else {
                        list.push({ band: layer.cfg.order, depth: 0, node, layer, chunk,
                                    indexOffset: 0, indexCount: chunk.mesh.indexCount });
                    }
                }
            }
        }

        list.sort((a, b) => (a.band - b.band) || (a.depth - b.depth));

        // Draw state is set once for the whole list rather than restored per item the way renderSprite
        // does: depth testing stays on so 3D geometry still occludes, but nothing here writes depth.
        GLState.blend(true);
        GLState.depthMask(false);
        const pass = this._begin2DPass();
        for (const item of list) {
            if ('sprite' in item) this.renderSprite(item.sprite, false, pass);
            else if ('particles' in item) {
                this._particlePasses.particles.draw([item.particles], this._particlePasses.particleDrawFrame(scene, pass, this._targets.scene.renderTarget));
                // Particle pipelines leave their own blend behind; the sprites after them expect the pass's.
                this._host.restoreDefaultBlend();
                GLState.blend(true);
                GLState.depthMask(false);
            }
            else this._drawTileBand(item.node, item.layer, item.chunk, item.indexOffset, item.indexCount, pass);
        }
        this._passes.endFullscreenPass(pass);
        GLState.depthMask(true);
    }

    /**
     * Open the pass the tiles and sprites share. Loads and stores — this draws over the composited
     * scene — and reserves the shadow units, since a custom material on a sprite is a legacy draw.
     */
    private _begin2DPass(): RenderPassEncoder {
        return this._passes.beginFullscreenPass(this._targets.scene.renderTarget, '2d', false, undefined, false);
    }

    /** Frustum test for one chunk, in world space. `origin` is the owning node's world position. */
    private _chunkVisible(tilemap: Tilemap, layer: TilemapLayer, chunk: TileChunk, origin: vec3): boolean {
        if (!this._host.frustumCulling) return true;
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
        return this._host.frustum.intersectsAABB(min, max);
    }

    private _drawTileBand(node: TilemapNode, layer: TilemapLayer, chunk: TileChunk,
                          indexOffset: number, indexCount: number,
                          pass?: RenderPassEncoder): void {
        const tilemap = node.tilemap;
        const tileset = tilemap.tilesetById(layer.cfg.tilesetId);
        if (!tileset || !chunk.mesh || indexCount <= 0) return;

        // The pipeline binds the program, but the uniforms below are written by name into the bound
        // program's block, so it still has to be current before them.
        const pipeline = pass ? this._pipelines.get('tilemap', TilemapProgram, {
            // What the pass set by hand: blended, depth-tested against the 3D scene, no depth writes
            // (tiles are sorted, and a written depth would occlude the band drawn after).
            cullMode: 'none',
            depthStencil: DEPTH_TEST,
            blend: DEFAULT_BLEND,
            vertex: 'tile',
        }) : null;
        if (pipeline) pass!.setPipeline(pipeline);
        this._shaderManager.bind('tilemap');
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));

        // Chunk meshes are in MAP-LOCAL space, so the node's world position belongs here — read off the
        // node, not `tilemap.origin`, which is stale until the scene ticks. Parallax and the layer z
        // offset ride in this matrix and ONLY here, never on the node's transform.
        const cam = this._view.camera.position;
        const origin = node.worldPosition;
        const model = mat4.create();
        mat4.fromTranslation(model, [
            origin[0] + cam[0] * (1 - layer.cfg.parallax[0]),
            origin[1] + cam[1] * (1 - layer.cfg.parallax[1]),
            origin[2] + layer.cfg.zOffset,
        ]);
        this._shaderManager.setUniform('u_model', model);

        const texture = TextureManager.Instance.getTexture(tileset.textureId)
            || TextureManager.Instance.getTexture('Null');
        if (pipeline) {
            pass!.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [texture ?? this._bindGroups.fallbackTexture]));
        } else {
            this._shaderManager.setUniform('u_tileset', 0);
            if (texture) texture.bind(0);
        }

        if (pipeline && chunk.mesh.vertexBuffer && chunk.mesh.indexBuffer) {
            pass!.setVertexBuffer(0, chunk.mesh.vertexBuffer);
            pass!.setIndexBuffer(chunk.mesh.indexBuffer, 'uint16');
            pass!.drawIndexed(indexCount, 1, indexOffset);
        } else {
            this._materials.applyCull('double');
            chunk.mesh.drawRange(indexOffset, indexCount);
        }
        frameStats.tilemapDraws++;
        frameStats.objects++;
    }

    /**
     * `manageDepth` false means the caller owns the blend/depth-mask state for a whole batch — the 2D
     * pass sets it once around its interleaved list.
     */
    public renderSprite(node: SpriteNode, manageDepth: boolean = true,
                          pass?: RenderPassEncoder, blend: BlendState = DEFAULT_BLEND): void {
        if (!node.initialized)
            node.initializeSprite();
        frameStats.objects++;

        this._shaderManager.bind(node.sprite.material.type);

        // A scene sprite authored additive (fire, glows) adds its light instead. The editor overlay's
        // icons keep the blend they were handed.
        const additive = blend === DEFAULT_BLEND && node.sprite.blend === 'additive';
        if (additive) blend = SPRITE_ADDITIVE_BLEND;

        // Everything the hand-written tail below sets, as pipeline state: always blended, never a
        // depth write (a blended sprite that wrote depth would occlude the ones sorted behind it),
        // and the material's own cull side and topology.
        const material = node.sprite.material;
        const reflection = FORWARD_PROGRAMS[material.type];
        const pipeline = pass && reflection ? this._pipelines.get(material.type, reflection, {
            cullMode: this._host.cullFor(material.config.side),
            depthStencil: DEPTH_TEST,
            // DEFAULT_BLEND for a scene sprite (its alpha must not touch the bloom mask), OVERLAY_BLEND
            // for an editor icon drawn into the overlay layer, where alpha IS coverage.
            blend,
            topology: material.config.wireframe ? 'line-list' : 'triangle-list',
            vertex: 'model',
            builtFor: material.type,
        }) : null;
        if (pipeline) pass!.setPipeline(pipeline);

        // The sprite's tile, as a sub-rect of the atlas. `basic.vs` does
        // `fragTexCoord = a_texCoord * u_uvScale + u_uvOffset` over the quad's baked 0..1 UVs, and
        // `Tileset.uvOf` already applies the V flip, so static and animated sprites share one path.
        const [u0, v0, u1, v1] = node.uvRect();
        this._shaderManager.setUniform('u_uvOffset', [u0, v0]);
        this._shaderManager.setUniform('u_uvScale', [u1 - u0, v1 - v0]);

        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        
        // constraint the sprite to always face the camera based on the node's constraints
        const spriteMatrix = mat4.clone(node.worldTransform);
        const constraints: 'free' | 'spherical' | 'cylindrical' = node.constraints;

        if (constraints === 'spherical') {
            spriteMatrix[0] = this._view.camera.viewMatrix[0];
            spriteMatrix[1] = this._view.camera.viewMatrix[4];
            spriteMatrix[2] = this._view.camera.viewMatrix[8];
            spriteMatrix[4] = this._view.camera.viewMatrix[1];
            spriteMatrix[5] = this._view.camera.viewMatrix[5];
            spriteMatrix[6] = this._view.camera.viewMatrix[9];
            spriteMatrix[8] = this._view.camera.viewMatrix[2];
            spriteMatrix[9] = this._view.camera.viewMatrix[6];
            spriteMatrix[10] = this._view.camera.viewMatrix[10];
            // reapply scaling
            mat4.scale(spriteMatrix, spriteMatrix, node.worldScale);
        }
        else if (constraints === 'cylindrical') {
            spriteMatrix[0] = this._view.camera.viewMatrix[0];
            spriteMatrix[1] = this._view.camera.viewMatrix[4];
            spriteMatrix[2] = this._view.camera.viewMatrix[8];
            spriteMatrix[4] = 0;
            spriteMatrix[5] = 1;
            spriteMatrix[6] = 0;
            spriteMatrix[8] = this._view.camera.viewMatrix[2];
            spriteMatrix[9] = this._view.camera.viewMatrix[6];
            spriteMatrix[10] = this._view.camera.viewMatrix[10];

            // reapply scaling
            mat4.scale(spriteMatrix, spriteMatrix, node.worldScale);
        }

        // SpriteNode.maxScreenSize: no taller than that many CSS pixels (the editor's viewport icons).
        if (node.maxScreenSize > 0)
            capSpriteScreenSize(spriteMatrix, node.maxScreenSize, this._view.camera, this._host.canvas.clientHeight);

        // Soft fade (Sprite.softness): the sprite keeps the plain depth test -- whatever stands in front of it
        // hides it, a torch head seen from below included -- and fades out over `softness` metres as it nears
        // the opaque surface BEHIND it (chunks/basicForward.wgsl, against the scene's depth snapshot), so a
        // flame set into its torch head or logs melts into them instead of being cut along a line. Off where
        // there is no live snapshot (a thumbnail, the overlay's icons).
        const cam = this._view.camera;
        const soft = blend !== OVERLAY_BLEND && !this._host.thumbnailMode ? node.sprite.softness : 0;
        material.properties.set('softness', soft);
        if (soft > 0) material.properties.set('depthParams', [cam.near, cam.far, cam.type === 'orthographic' ? 1 : 0, 1]);

        this._shaderManager.setUniform('u_model', spriteMatrix);
        this._materials.setDissolve(node.effectiveFade);

        // Per draw, from the tile on screen: an animated sprite follows its frame's overdrive, and two
        // sprites sharing a tileset never fight over one value. A sprite that takes less than the whole
        // exposure (Sprite.exposureWeight) is divided by the rest of it here; the tonemapper multiplies by all.
        const weight = node.sprite.exposureWeight;
        material.properties.set('intensity', weight < 1 && this._view.exposure > 0
            ? node.overdrive * Math.pow(this._view.exposure, weight - 1) : node.overdrive);

        // Set material uniforms + bind textures
        if (pipeline) {
            this._materials.applyProperties(material);
            pass!.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
        } else this._materials.apply(material);

        const materialConfig = node.sprite.material.config;

        // Sprites are always transparent
        this._shaderManager.setUniform('u_isTransparent', true);
        if (!pipeline) {
            GLState.blend(true);
            if (additive && gl) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
            // Don't write to depth for blended sprites to avoid occluding later sprites
            GLState.depthMask(false);
            this._materials.applyCull(materialConfig.side);
        }

        const topology = materialConfig.wireframe ? 'line-list' : 'triangle-list';
        if (!pipeline || !this._passes.recordDraw(pass!, node.sprite.mesh, 0, 0))
            node.sprite.mesh.draw(topology);
        if (!pipeline && additive) this._host.restoreDefaultBlend();

        // Restore depth writes after drawing sprite
        if (manageDepth) GLState.depthMask(true);
    }

    /** Builds a sprite's world matrix with its camera-facing billboard constraint applied. */
    public spriteBillboardMatrix(node: SpriteNode): mat4 {
        const m = mat4.clone(node.worldTransform);
        const view = this._view.camera.viewMatrix;
        const constraints: 'free' | 'spherical' | 'cylindrical' = node.constraints;
        if (constraints === 'spherical') {
            m[0] = view[0]; m[1] = view[4]; m[2] = view[8];
            m[4] = view[1]; m[5] = view[5]; m[6] = view[9];
            m[8] = view[2]; m[9] = view[6]; m[10] = view[10];
            mat4.scale(m, m, node.worldScale);
        } else if (constraints === 'cylindrical') {
            m[0] = view[0]; m[1] = view[4]; m[2] = view[8];
            m[4] = 0; m[5] = 1; m[6] = 0;
            m[8] = view[2]; m[9] = view[6]; m[10] = view[10];
            mat4.scale(m, m, node.worldScale);
        }
        return m;
    }
}
