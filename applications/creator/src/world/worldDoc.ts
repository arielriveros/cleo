// A World Creator document: the world's frame, the terrain as a node graph (graph/), the painted masks it
// reads, the surfaces that texture it, the lakes, and how the preview shows it. Plain JSON, so it saves,
// diffs and travels in the export sidecar as-is. Version 3; versions 1 and 2 (a landform stack and erosion
// passes) migrate to a chain graph that evaluates bit for bit as they did.

import type { WorldLayer } from './features';
import { graphKey, type WorldGraph } from './graph/graphDoc';
import { graphFromStack, normaliseGraph, type LegacyErosionPass } from './graph/migrate';
import { DEFAULT_LAKES, type LakeSettings } from './lakes';
import type { PaintMaskMeta } from './paint';
import { normaliseSurfaces, surfaceExportKey, type SurfaceLayer } from './surfaces/surfaceDoc';
import { defaultSurfaces } from './surfaces/presets';
import { DEFAULT_WATER_LOOK, normaliseWaterLook, type WaterLook } from './water/waterLook';

export interface WorldSettings {
  /** Samples per side; 2^n + 1 so it matches the engine's terrain grids (257 .. 4097). */
  resolution: number;
  /** World units across the map. */
  size: number;
  /** World units of a normalised height of 1. */
  heightScale: number;
  seed: number;
  /** Normalised sea level: the preview's sea, and what the water rules measure from. */
  seaLevel: number;
}

/** Preview quality: the live landscape's grid and paint-mask resolution. */
export type PreviewQuality = 'draft' | 'fine';

export const PREVIEW_QUALITY: Record<PreviewQuality, { heights: number; masks: number }> = {
  draft: { heights: 257, masks: 512 },
  fine: { heights: 513, masks: 1024 },
};

/** How the preview shows the world. Never exported, never part of the export hash. */
export interface WorldPreview {
  quality: PreviewQuality;
  water: WaterLook;
}

/** What the export writes beyond the heights (the Export tab). */
export interface WorldOutputSettings {
  /** Splat / weight map texels per side. */
  splatResolution: number;
  /** RGBA splatmaps, four normalised layers each (Unity, Godot, custom shaders). */
  splat: boolean;
  /** One grayscale weight map per layer (Unreal weight-blended layers, Gaea, Blender). */
  weightmaps: boolean;
  /** 32-bit float heights, OpenEXR. */
  exr: boolean;
  /** Which data masks to write. */
  masks: string[];
  /** Data masks at 16 bits rather than 8. */
  masks16: boolean;
  /** Download one zip rather than separate files. */
  zip: boolean;
}

export const SPLAT_RESOLUTIONS = [512, 1024, 2048, 4096] as const;

export const DEFAULT_OUTPUT: WorldOutputSettings = {
  splatResolution: 1024, splat: true, weightmaps: true, exr: false,
  masks: ['slope', 'curvature', 'flow', 'wetness'], masks16: false, zip: true,
};

export interface WorldDoc {
  version: 3;
  settings: WorldSettings;
  graph: WorldGraph;
  /** The painted masks' descriptions; their pixels travel beside the document (paint.ts). */
  paint: PaintMaskMeta[];
  /** Bottom to top; index 0 is the base and covers everything. */
  surfaces: SurfaceLayer[];
  water: { lakes: LakeSettings };
  output: WorldOutputSettings;
  preview: WorldPreview;
}

export const RESOLUTIONS = [257, 513, 1025, 2049, 4097] as const;

export { newId } from './ids';

export const DEFAULT_SETTINGS: WorldSettings = { resolution: 513, size: 2048, heightScale: 600, seed: 1, seaLevel: 0.1 };

export const DEFAULT_PREVIEW: WorldPreview = { quality: 'draft', water: DEFAULT_WATER_LOOK };

/** A document's non-terrain parts, for a preset that builds only the graph. */
export function worldExtras(): Pick<WorldDoc, 'version' | 'paint' | 'surfaces' | 'water' | 'output' | 'preview'> {
  return { version: 3, paint: [], surfaces: defaultSurfaces(), water: { lakes: { ...DEFAULT_LAKES } }, output: { ...DEFAULT_OUTPUT, masks: [...DEFAULT_OUTPUT.masks] }, preview: { ...DEFAULT_PREVIEW } };
}

/** What a version-1 or -2 document stored instead of a graph. */
interface LegacyTerrain { layers?: WorldLayer[]; erosion?: LegacyErosionPass[] }

/**
 * Any stored world (a version-1 or -2 document, a library asset, a preset) brought up to the current
 * shape. Version 1 documents get the default (temperate) surface stack; versions 1 and 2 get their stack
 * as a chain graph.
 */
export function normaliseWorld(raw: unknown): WorldDoc {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorldDoc> & LegacyTerrain;
  const extras = worldExtras();
  const lakes = { ...DEFAULT_LAKES, ...(r.water?.lakes ?? {}) };
  const output = { ...extras.output, ...(r.output ?? {}) };
  if (!SPLAT_RESOLUTIONS.includes(output.splatResolution as typeof SPLAT_RESOLUTIONS[number])) output.splatResolution = DEFAULT_OUTPUT.splatResolution;
  if (!Array.isArray(output.masks)) output.masks = [...DEFAULT_OUTPUT.masks];
  const preview = r.preview ?? extras.preview;
  const graph = r.graph
    ? normaliseGraph(r.graph)
    : normaliseGraph(graphFromStack(Array.isArray(r.layers) ? r.layers : [], Array.isArray(r.erosion) ? r.erosion : []));
  const paint = (Array.isArray(r.paint) ? r.paint : []).filter(m => m && typeof m.id === 'string' && Number.isFinite(m.resolution))
    .map(m => ({ id: m.id, name: typeof m.name === 'string' ? m.name : 'Mask', resolution: m.resolution, signed: !!m.signed, hash: typeof m.hash === 'string' ? m.hash : '' }));
  return {
    version: 3,
    settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) },
    graph,
    paint,
    surfaces: normaliseSurfaces(r.surfaces, defaultSurfaces),
    water: { lakes },
    output,
    preview: { quality: preview.quality === 'fine' ? 'fine' : 'draft', water: normaliseWaterLook(preview.water) },
  };
}

const paintKey = (doc: WorldDoc) => doc.paint.map(m => [m.id, m.resolution, m.signed, m.hash]);

/** The parts of a document that decide the terrain (heights, erosion): what the terrain stage caches on. */
export function terrainKey(doc: WorldDoc, resolution: number): string {
  return JSON.stringify([resolution, doc.settings.size, doc.settings.heightScale, doc.settings.seed, graphKey(doc.graph), paintKey(doc)]);
}

/**
 * The parts that decide the exported files: everything but the preview (and preview-only surface looks).
 * Node positions and names are layout, so moving a node on the canvas never changes the export.
 */
export function exportKey(doc: WorldDoc): string {
  return JSON.stringify([doc.settings, graphKey(doc.graph), paintKey(doc), doc.water, doc.output, doc.surfaces.map(surfaceExportKey)]);
}
