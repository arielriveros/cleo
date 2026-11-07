import { vec3, mat4 } from 'gl-matrix';
import { dissolveOf } from '../objectData';
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
import { DEFAULT_BLEND, SPRITE_ADDITIVE_BLEND, OVERLAY_BLEND } from '../rhi/types';
import type { BlendState } from '../rhi/types';
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
import { ModelDraw } from './modelDraw';
import type { RenderSubsystems } from './subsystems';
import { gatherParticleLocalLight } from '../particles/particleLighting';
import { billboardMatrix } from './billboard';
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
     */
    public render2DPass(scene: Scene): void {
        const sprites: SpriteNode[] = [];
        // Scene content only. The editor's light/sound/probe icons are billboards in `scene.sprites`
        // too, and they belong to the overlay layer — see `EditorOverlays.renderEditorOverlay`. Not one
        // inside an occlusion volume the camera cannot see.
        for (const node of scene.sprites)
            if (node.visible && !isEditorOnlyNode(node) && !this._sys.visibility.volumeCulled(node)) sprites.push(node);

        const tilemaps: TilemapNode[] = [];
        for (const node of scene.tilemaps) if (node.visible) tilemaps.push(node);

        if (tilemaps.length === 0) {
            // Back-to-front so blended sprites composite correctly. Selection outlines come from the
            // mask pass, so there is no special-casing of the selected sprite here.
            sprites.sort((a, b) =>
                vec3.distance(this._view.camera.position, b.worldPosition) -
                vec3.distance(this._view.camera.position, a.worldPosition));
            const only = this._begin2DPass();
            for (const node of sprites) this.renderSprite(node, only);
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
            if (!particles.visible || this._sys.visibility.volumeCulled(particles)) continue;
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

        // One pass for the whole interleaved list. Every item's pipeline depth-tests without writing
        // depth, so 3D geometry still occludes the 2D layer and the 2D layer never occludes itself.
        const pass = this._begin2DPass();
        for (const item of list) {
            if ('sprite' in item) this.renderSprite(item.sprite, pass);
            else if ('particles' in item)
                this._particlePasses.particles.draw([item.particles], this._particlePasses.particleDrawFrame(scene, pass, this._targets.scene.renderTarget));
            else this._drawTileBand(item.node, item.layer, item.chunk, item.indexOffset, item.indexCount, pass);
        }
        this._passes.endFullscreenPass(pass);
    }

    /** Open the pass the tiles and sprites share. Loads and stores: this draws over the composited scene. */
    private _begin2DPass(): RenderPassEncoder {
        return this._passes.beginFullscreenPass(this._targets.scene.renderTarget, '2d', false, undefined, false);
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
        const model = mat4.create();
        mat4.fromTranslation(model, [
            origin[0] + cam[0] * (1 - layer.cfg.parallax[0]),
            origin[1] + cam[1] * (1 - layer.cfg.parallax[1]),
            origin[2] + layer.cfg.zOffset,
        ]);
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

    /** Record one sprite into `pass`, blended by `blend` (an editor icon passes OVERLAY_BLEND). */
    public renderSprite(node: SpriteNode, pass?: RenderPassEncoder, blend: BlendState = DEFAULT_BLEND): void {
        if (!node.initialized)
            node.initializeSprite();
        frameStats.objects++;

        // A lit sprite (Sprite.lit) draws with its own material and program; the overlay's icons never do.
        const material = blend === OVERLAY_BLEND ? node.sprite.material : node.sprite.drawMaterial();
        this._shaderManager.bind(material.type);

        // A scene sprite authored additive (fire, glows) adds its light instead. The editor overlay's
        // icons keep the blend they were handed.
        const additive = blend === DEFAULT_BLEND && node.sprite.blend === 'additive';
        if (additive) blend = SPRITE_ADDITIVE_BLEND;

        // Everything the hand-written tail below sets, as pipeline state: always blended, never a
        // depth write (a blended sprite that wrote depth would occlude the ones sorted behind it),
        // and the material's own cull side and topology.
        const reflection = FORWARD_PROGRAMS[material.type];
        if (!pass || !reflection) return;
        const pipeline = this._pipelines.get(material.type, reflection, {
            cullMode: ModelDraw.cullFor(material.config.side),
            depthStencil: DEPTH_TEST,
            // DEFAULT_BLEND for a scene sprite (its alpha must not touch the bloom mask), OVERLAY_BLEND
            // for an editor icon drawn into the overlay layer, where alpha IS coverage.
            blend,
            topology: material.config.wireframe ? 'line-list' : 'triangle-list',
            vertex: 'model',
            builtFor: material.type,
        });
        pass.setPipeline(pipeline);

        // The sprite's tile, as a sub-rect of the atlas. `basic.vs` does
        // `fragTexCoord = a_texCoord * u_uvScale + u_uvOffset` over the quad's baked 0..1 UVs, and
        // `Tileset.uvOf` already applies the V flip, so static and animated sprites share one path.
        const [u0, v0, u1, v1] = node.uvRect();
        this._shaderManager.setUniform('u_uvOffset', [u0, v0]);
        this._shaderManager.setUniform('u_uvScale', [u1 - u0, v1 - v0]);

        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        
        // The camera-facing constraint (render/billboard.ts): screen-aligned, or turned about its upright axis
        // to face the camera's position.
        const spriteMatrix = this.spriteBillboardMatrix(node);

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
        const lit = material.type === 'spriteLit';
        // The frame's cluster grid, when the lit program has it bound: every local light per pixel.
        const gridLights = lit && this._bindGroups.declaresFrameLighting(pipeline) && !this._host.thumbnailMode && !this._view.capturing;
        if (lit) this._setSpriteLight(node, material, spriteMatrix, gridLights);
        if (gridLights) this._sys.lighting.lightGrid.uploadUniforms(this._shaderManager);

        // Per draw, from the tile on screen: an animated sprite follows its frame's overdrive, and two
        // sprites sharing a tileset never fight over one value. A sprite that takes less than the whole
        // exposure (Sprite.exposureWeight) is divided by the rest of it here; the tonemapper multiplies by all.
        const weight = node.sprite.exposureWeight;
        // A sprite that burns with a light (Sprite.followLight) swells and dims on the light's own beat.
        const drive = node.overdrive * node.lightFollowScale;
        material.properties.set('intensity', weight < 1 && this._view.exposure > 0
            ? drive * Math.pow(this._view.exposure, weight - 1) : drive);

        // Set material uniforms + bind textures
        let record = 0;
        this._materials.applyProperties(material);
        pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
        if (lit && this._bindGroups.declaresShadowGroup(pipeline)) {
            // The key light's cascades: a lit sprite takes the shadows the sun casts on it.
            this._sys.shadows.uploadShadowUniforms(material.type);
            pass.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline, false));
        }
        // The Basic program reads the matrix, the dissolve and the tile from the per-object table.
        if (this._bindGroups.declaresObjectData(pipeline)) {
            const objects = this._sys.objects;
            record = objects.rowFor(node, spriteMatrix, dissolveOf(node.effectiveFade), false, 0,
                                    u1 - u0, v1 - v0, u0, v0);
            pass.setBindGroup(2, this._bindGroups.objectDataGroup(pipeline, objects.texture));
        }

        // Sprites are always transparent
        this._shaderManager.setUniform('u_isTransparent', true);
        this._passes.recordDraw(pass, node.sprite.mesh, 0, 0, -1, record);
    }

    /**
     * A lit sprite's light (Sprite.lit, spriteLit.wgsl): the frame's key light and fill as lit particles
     * take them, plus the strongest local light at the sprite, and the sprite's own frame -- its right, up
     * and BACK (away from the camera), the frame the Creator bakes six-way lightmaps and normals in. A
     * quad seen from behind (a free sprite) shows its texture mirrored, so its frame is mirrored with it.
     */
    private _setSpriteLight(node: SpriteNode, material: Material, m: mat4, gridLights: boolean): void {
        material.properties.set('gridLights', gridLights ? 1 : 0);
        const right = vec3.normalize(this._litRight, vec3.set(this._litRight, m[0], m[1], m[2]));
        const up = vec3.normalize(this._litUp, vec3.set(this._litUp, m[4], m[5], m[6]));
        const back = vec3.cross(this._litBack, right, up);
        vec3.normalize(back, vec3.negate(back, back));
        const cam = this._view.camera.position;
        if ((m[12] - cam[0]) * back[0] + (m[13] - cam[1]) * back[1] + (m[14] - cam[2]) * back[2] < 0) {
            vec3.negate(back, back);
            vec3.negate(right, right);
        }
        material.properties.set('right', [right[0], right[1], right[2]]);
        material.properties.set('up', [up[0], up[1], up[2]]);
        material.properties.set('back', [back[0], back[1], back[2]]);
        material.properties.set('lightRadius', spriteLightRadius(m));

        const scene = node.scene;
        if (!scene) {
            material.properties.set('sunColor', [0, 0, 0]);
            material.properties.set('keyColor', [0, 0, 0]);
            material.properties.set('ambient', [0, 0, 0]);
            return;
        }
        const light = this._particlePasses.frameLight(scene);
        // With the grid, every local light is evaluated per pixel (spriteLit.wgsl localLights): no CPU key,
        // and none of their fill folded into the ambient.
        const local = gridLights ? NO_LOCAL_LIGHT : gatherParticleLocalLight([m[12], m[13], m[14]], light.localLights);
        material.properties.set('sunDir', [light.sunDirection[0], light.sunDirection[1], light.sunDirection[2]]);
        material.properties.set('sunColor', [light.sunColor[0], light.sunColor[1], light.sunColor[2]]);
        // The fill where the sprite stands: a light probe's in its volume (a room's smoke is lit by the
        // room), else the scene ambient and sky light (render/probeLighting.ts).
        const ambient = this._sys.lighting.probeAmbientAt(scene, vec3.set(this._litPos, m[12], m[13], m[14]), light.ambient, this._litAmbient);
        // As lit particles: the fill of the local lights past the key joins the ambient, through the 1/π.
        material.properties.set('ambient', [ambient[0] + local.fill[0] / Math.PI, ambient[1] + local.fill[1] / Math.PI,
                                            ambient[2] + local.fill[2] / Math.PI]);
        material.properties.set('keyDir', local.keyDirection);
        material.properties.set('keyColor', local.keyColor);
    }

    private readonly _litRight = vec3.create();
    private readonly _litPos = vec3.create();
    private readonly _litAmbient: number[] = [0, 0, 0];
    private readonly _litUp = vec3.create();
    private readonly _litBack = vec3.create();

    /** Builds a sprite's world matrix with its camera-facing billboard constraint applied (render/billboard.ts). */
    public spriteBillboardMatrix(node: SpriteNode): mat4 {
        const cam = this._view.camera;
        return billboardMatrix(mat4.create(), node.worldTransform, node.worldScale, node.constraints,
                               cam.viewMatrix, cam.position, cam.type !== 'orthographic');
    }
}
