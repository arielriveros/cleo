import type { LightingPasses } from './lighting';
import type { SsrPasses } from './ssr';
import type { SkyPasses } from './sky';
import type { ShadowPasses } from './shadows';
import type { Visibility } from './visibility';
import type { ModelDraw } from './modelDraw';
import type { GeometryPass } from './geometryPass';
import type { DebugViews } from './debugViews';
import type { EditorOverlays } from './editorOverlays';
import type { Capture } from './capture';
import type { ProgramRegistry } from './programRegistry';
import type { ObjectTable } from '../objectTable';
import type { GiSystem } from './gi/giSystem';

/**
 * The renderer's subsystems, for the ones that reach each other while drawing. Filled once, at the end of
 * the Renderer constructor, after every subsystem exists, and only read at draw time. A handle rather than
 * constructor arguments because several pairs need each other — lighting and the sky, shadows and
 * lighting, foliage and shadows, the clouds and both — so no construction order could hand every
 * subsystem its dependencies up front.
 */
export interface RenderSubsystems {
    readonly lighting: LightingPasses;
    /** Screen-space reflections, whose result the lighting pass blends over the environment's. */
    readonly ssr: SsrPasses;
    readonly sky: SkyPasses;
    readonly shadows: ShadowPasses;
    readonly visibility: Visibility;
    readonly modelDraw: ModelDraw;
    readonly geometry: GeometryPass;
    readonly debugViews: DebugViews;
    readonly overlays: EditorOverlays;
    readonly capture: Capture;
    readonly programs: ProgramRegistry;
    /** The per-object table every converted draw reads its matrix and per-object values from. */
    readonly objects: ObjectTable;
    /** GI Volumes: their capture, relight and apply (render/gi/giSystem.ts). */
    readonly gi: GiSystem;
}
