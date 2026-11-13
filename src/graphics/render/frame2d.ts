import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import type { ModelNode } from '../../core/scene/nodes/modelNode';
import type { SpriteNode } from '../../core/scene/nodes/spriteNode';
import type { Scene } from '../../core/scene/scene';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { LightingPasses } from './lighting';
import type { ShadowPasses } from './shadows';
import type { DecalPasses } from './decals';
import type { Sprite2DPasses } from './sprites2d';
import type { EditorOverlays } from './editorOverlays';

/** What the flat 2D frame reads from the renderer that owns it. */
export interface Frame2DHost {
    readonly thumbnailMode: boolean;
    readonly selectedNodeId: string | null;
    readonly clearColor: number[];
}

/**
 * The scene half of the flat 2D frame (`Renderer._renderFrame2D`): the background, the one sorted 2D pass
 * (tilemap layers, sprites and particles, render/sprites2d.ts), and the editor's chrome and selection mask.
 * Nothing 3D runs: no shadows, G-buffer, deferred lighting, sky, temporal resolve or exposure meter. A 2D
 * scene's 3D models are not drawn here at all -- a scene that mixes them in asks for the full pipeline
 * (`RenderSettings.pipeline2D: 'full'`).
 */
export class Frame2DPasses {
    constructor(private readonly _host: Frame2DHost,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _lighting: LightingPasses,
                private readonly _shadows: ShadowPasses,
                private readonly _decals: DecalPasses,
                private readonly _sprites: Sprite2DPasses,
                private readonly _overlays: EditorOverlays) {}

    /** The chrome found among the scene's models this frame, reused so a frame allocates nothing. */
    private readonly _gizmos: ModelNode[] = [];
    private readonly _helpers: ModelNode[] = [];
    private readonly _selectedSprites: SpriteNode[] = [];

    public render(scene: Scene): void {
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
        this._passes.endFullscreenPass(this._passes.beginFullscreenPass(this._targets.scene.renderTarget, '2d.clear', true, bg, true));

        // Everything the scene shows, in one sorted, batched pass.
        if (this._passes.beginPass('2d')) this._sprites.render2DPass(scene);

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
}
