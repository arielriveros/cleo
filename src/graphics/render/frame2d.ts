import { mat4, vec3 } from 'gl-matrix';
import { Camera } from '../../core/camera';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import type { Camera2DNode } from '../../core/scene/nodes/camera2DNode';
import type { ModelNode } from '../../core/scene/nodes/modelNode';
import type { SpriteNode } from '../../core/scene/nodes/spriteNode';
import type { Scene } from '../../core/scene/scene';
import { Framebuffer } from '../framebuffer';
import { ShaderManager } from '../systems/shaderManager';
import type { FrameTargets } from './frameTargets';
import type { FrameView } from './frameView';
import type { PassEncoder } from './passEncoder';
import type { LightingPasses } from './lighting';
import type { ShadowPasses } from './shadows';
import type { DecalPasses } from './decals';
import type { Sprite2DPasses } from './sprites2d';
import type { EditorOverlays } from './editorOverlays';
import type { FullscreenPasses } from './fullscreenPasses';
import type { ViewProjection } from './viewProjection';
import { PixelUpscaleProgram } from './programs';

/** What the flat 2D frame reads from the renderer that owns it. */
export interface Frame2DHost {
    readonly thumbnailMode: boolean;
    readonly selectedNodeId: string | null;
    readonly clearColor: number[];
}

/** Art pixels of margin round a pixel-perfect frame's low-resolution target, for the sub-pixel shift. */
const PIXEL_MARGIN = 2;

/**
 * The scene half of the flat 2D frame (`Renderer._renderFrame2D`): the background, the one sorted 2D pass
 * (tilemap layers, sprites and particles, render/sprites2d.ts), and the editor's chrome and selection mask.
 * Nothing 3D runs: no shadows, G-buffer, deferred lighting, sky, temporal resolve or exposure meter. A 2D
 * scene's 3D models are not drawn here at all -- a scene that mixes them in asks for the full pipeline
 * (`RenderSettings.pipeline2D: 'full'`).
 *
 * PIXEL-PERFECT (a Camera2DNode with `pixelPerfect`): the 2D pass draws into a target at the camera's art
 * resolution through a copy of the camera snapped to the art-pixel grid, and `pixelUpscale` scales that up
 * into the scene buffer unfiltered, shifted by the sub-pixel part of the camera's position. Everything
 * after -- the post chain, the editor's chrome -- runs at full resolution through the real camera.
 */
export class Frame2DPasses {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: Frame2DHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _projection: ViewProjection,
                private readonly _lighting: LightingPasses,
                private readonly _shadows: ShadowPasses,
                private readonly _decals: DecalPasses,
                private readonly _sprites: Sprite2DPasses,
                private readonly _overlays: EditorOverlays) {}

    /** The chrome found among the scene's models this frame, reused so a frame allocates nothing. */
    private readonly _gizmos: ModelNode[] = [];
    private readonly _helpers: ModelNode[] = [];
    private readonly _selectedSprites: SpriteNode[] = [];

    /** The pixel-perfect frame's art-resolution target, its snapped camera and the upscale's matrix. */
    private _lowRes: Framebuffer | null = null;
    private readonly _snapped = new Camera({ type: 'orthographic' });
    private readonly _inverse = mat4.create();
    private readonly _snappedViewProj = mat4.create();
    private readonly _upscaleMap = mat4.create();
    private readonly _eyeOffset = vec3.create();
    private readonly _snappedPosition = vec3.create();

    /**
     * Draw the 2D scene. `pixel` is the active 2D camera when the frame is pixel-perfect, else null; it was
     * fitted to the screen (Camera2DNode.fitView) before the frame's matrices were built.
     */
    public render(scene: Scene, pixel: Camera2DNode | null = null): void {
        // Editor chrome among the models, split as the forward overlay splits it: a gizmo draws through
        // everything, a helper wireframe is occluded by the depth in front of it.
        const gizmos = this._gizmos, helpers = this._helpers;
        gizmos.length = 0;
        helpers.length = 0;
        for (const node of scene.models) {
            if (!node.visible || !isEditorOnlyNode(node)) continue;
            ((node as any).isGizmo ? gizmos : helpers).push(node);
        }

        // No shadow caster draws in this frame, so the shadow maps would still hold the last 3D frame's
        // depth (a 3D tab, or the scene before it became 2D). Cleared once, as the 3D frame does when it has
        // no caster; a no-op every frame after.
        this._shadows.shadowLight = null;
        this._shadows.shadowsActive = false;
        this._shadows.clearShadowMaps();

        // Chrome that is LIT (the camera gizmo is Blinn-Phong) reads the frame's lights from group 3, like
        // any forward draw: give it this frame's, from whatever lights the scene holds. Only when there is
        // chrome to draw, which a published game never has.
        if (gizmos.length > 0 || helpers.length > 0) {
            this._passes.scope('lightGrid');
            this._lighting.buildLightGrid(scene);
            this._lighting.resetForwardLighting(scene);
            for (const light of scene.lights) this._lighting.setDirectionalOnForward(light);
            this._lighting.bindShadowsToForwardShaders();
            this._lighting.bindEnvToForwardShaders(scene);
        }
        // The editor-only decals (none in a 2D scene) the overlay draws, so last frame's never linger.
        this._decals.collectDecals(scene);

        // The background: colour and depth together. Alpha 0, the empty bloom mask, as the 3D frame's
        // lighting pass clears it; a thumbnail clears to transparent black.
        this._passes.scope('2d');
        const cc = this._host.clearColor;
        const bg: [number, number, number, number] = this._host.thumbnailMode ? [0, 0, 0, 0] : [cc[0], cc[1], cc[2], 0];

        if (pixel) this._renderPixelPerfect(scene, pixel, bg);
        else {
            this._passes.endFullscreenPass(this._passes.beginFullscreenPass(this._targets.scene.renderTarget, '2d.clear', true, bg, true));
            // Everything the scene shows, in one sorted, batched pass.
            if (this._passes.beginPass('2d')) this._sprites.render2DPass(scene);
        }

        // Editor chrome, into the overlay layer the post chain never sees.
        this._overlays.renderEditorOverlay(scene, helpers, gizmos);

        // The selection silhouette: a selected sprite (a 2D scene's models are not drawn, so neither is
        // their outline).
        const selected = this._selectedSprites;
        selected.length = 0;
        const id = this._host.selectedNodeId;
        if (id) for (const node of scene.sprites) if (node.visible && node.id === id) selected.push(node);
        this._passes.scope('outlineMask');
        this._overlays.renderSelectionMask([], selected);
    }

    /**
     * The pixel-perfect half: the 2D pass at art resolution through the snapped camera, then scaled up into
     * the scene buffer (whose depth it clears, for the chrome that borrows it).
     */
    private _renderPixelPerfect(scene: Scene, camera2D: Camera2DNode, bg: [number, number, number, number]): void {
        const logical = this._view.camera;
        const scale = Math.max(1, Math.round(camera2D.layout.scale));
        const w = Math.ceil(this._targets.scene.width / scale) + 2 * PIXEL_MARGIN;
        const h = Math.ceil(this._targets.scene.height / scale) + 2 * PIXEL_MARGIN;
        const target = this._lowResTarget(w, h);

        // The camera snapped to the art-pixel grid, the target's size in art pixels.
        const ppu = Math.max(1e-6, camera2D.pixelsPerUnit);
        const snapped = this._snapped;
        const p = logical.position;
        vec3.set(this._snappedPosition, Math.round(p[0] * ppu) / ppu, Math.round(p[1] * ppu) / ppu, p[2]);
        vec3.subtract(this._eyeOffset, logical.eye, p);
        snapped.position = this._snappedPosition;
        snapped.eye = vec3.add(this._eyeOffset, this._snappedPosition, this._eyeOffset);
        snapped.up = logical.up;
        snapped.near = logical.near;
        snapped.far = logical.far;
        const half = h / (2 * ppu);
        snapped.left = -half; snapped.right = half; snapped.bottom = -half; snapped.top = half;
        snapped.resize(w, h);

        this._passes.endFullscreenPass(this._passes.beginFullscreenPass(target.renderTarget, '2d.clear', true, bg, true));
        if (this._passes.beginPass('2d')) {
            this._view.camera = snapped;
            try { this._sprites.render2DPass(scene, target.renderTarget); }
            finally { this._view.camera = logical; }
        }

        // A screen clip position, back to the world through the real camera, on through the snapped one.
        mat4.invert(this._inverse, this._view.viewProj);
        this._projection.uvConsuming(this._inverse, this._inverse);
        mat4.multiply(this._snappedViewProj, snapped.projectionMatrix, snapped.viewMatrix);
        mat4.multiply(this._upscaleMap, this._projection.uvProducing(this._snappedViewProj), this._inverse);

        const pass = this._passes.beginFullscreenPass(this._targets.scene.renderTarget, '2d.upscale', true, bg, true);
        this._fullscreen.bind(pass, 'pixelUpscale', PixelUpscaleProgram, [target.colors[0]]);
        this._shaderManager.setUniform('u_upscaleMap', this._upscaleMap);
        this._passes.drawFullscreenAndEnd(pass);
    }

    /** The art-resolution target, nearest-filtered, at `w` x `h`. Same formats as the scene buffer. */
    private _lowResTarget(w: number, h: number): Framebuffer {
        if (!this._lowRes) this._lowRes = new Framebuffer({ colorTextureOptions: {
            mipMap: false, precision: 'high', minFilter: 'nearest', magFilter: 'nearest', wrapping: 'clamp',
        } });
        if (this._lowRes.width !== w || this._lowRes.height !== h) this._lowRes.create(w, h);
        return this._lowRes;
    }

    /** Free the art-resolution target (a resize past it, a device loss). */
    public dispose(): void {
        this._lowRes?.destroy();
        this._lowRes = null;
    }
}
