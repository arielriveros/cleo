import type { LightingPasses } from './lighting';
import type { SkyPasses } from './sky';
import type { ShadowPasses } from './shadows';
import type { Visibility } from './visibility';
import type { ModelDraw } from './modelDraw';
import type { GeometryPass } from './geometryPass';
import type { DebugViews } from './debugViews';
import type { EditorOverlays } from './editorOverlays';
import type { Capture } from './capture';
import type { ProgramRegistry } from './programRegistry';

/**
 * The renderer's subsystems, for the ones that reach each other while drawing. Filled once, at the end of
 * the Renderer constructor, after every subsystem exists, and only read at draw time. A handle rather than
 * constructor arguments because several pairs need each other — lighting and the sky, shadows and
 * lighting, foliage and shadows, the clouds and both — so no construction order could hand every
 * subsystem its dependencies up front.
 */
export interface RenderSubsystems {
    readonly lighting: LightingPasses;
    readonly sky: SkyPasses;
    readonly shadows: ShadowPasses;
    readonly visibility: Visibility;
    readonly modelDraw: ModelDraw;
    readonly geometry: GeometryPass;
    readonly debugViews: DebugViews;
    readonly overlays: EditorOverlays;
    readonly capture: Capture;
    readonly programs: ProgramRegistry;
}
