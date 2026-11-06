// The World's export: industry-standard files any engine reads, and a manifest saying what each one is.
//
//   <n>_height.png           16-bit greyscale, normalised over [minHeight, maxHeight] (the manifest's)
//   <n>_height.r16           the same samples, headerless little-endian uint16 (Unity, Unreal)
//   <n>_height.exr           optional: 32-bit float heights in metres (Houdini, Gaea, Blender)
//   <n>_<mask>.png           data masks, 0..1, 8- or 16-bit greyscale
//   <n>_splat_<k>.png        RGBA8, four layers' normalised weights each (Unity alphamaps, Godot, shaders)
//   <n>_weight_<ii>_<s>.png  8-bit greyscale weight map per layer (Unreal weight-blended layers, Gaea)
//   <n>.json                 the manifest (the sidecar): sizes, height range, layers -> files/channels, water
//
// Heights are vertex-aligned (resolution = 2^n + 1, sample 0 on the -X/-Z corner); splat and weight maps
// are texel-centred over the same square. Row 0 is the -Z edge, column 0 the -X edge.
//
// Surfaces export as WHERE, never as WHAT: the generated preview materials stay in the Creator, and a
// layer's `kind`/`color` in the manifest are hints for whoever assigns the real materials.

import { encodePng16, encodeRaw16, imageFromHeights } from 'cleo/terrain/heightmapIO';
import { encodePngGray8, encodePngGray8Bytes, encodePngRgba8 } from '../core/png';
import { encodeExrFloat } from '../core/exr';
import { fnv1a, sidecar, type ExportFile } from '../core/generator';
import { surfaceKindInfo } from '../surfaces/kinds';
import type { WorldFields } from './fields';
import type { WorldOutput } from './generateWorld';
import { WATER_DRY } from './lakes';
import { MASK_KINDS } from './masks';
import { buildFields, buildSurfaces } from './pipeline';
import type { SurfaceAlphas } from './surfaces/evaluate';
import { alphasToWeights, coverage, packSplat } from './surfaces/weights';
import { exportKey, type WorldDoc } from './worldDoc';

/** Every data mask the export can write, with how its 0..1 reads. */
export const EXPORT_MASKS: { id: string; label: string; meaning: string }[] = [
  { id: 'slope', label: 'Slope', meaning: 'steepness: 0 flat .. 1 vertical (degrees / 90)' },
  { id: 'curvature', label: 'Curvature', meaning: '0.5 flat, above convex (crests), below concave (gullies)' },
  { id: 'flow', label: 'Flow', meaning: 'water flow, log-scaled, relative to this map' },
  { id: 'wetness', label: 'Wetness', meaning: 'where water collects and lingers, 0..1' },
  { id: 'aspect', label: 'Aspect', meaning: 'the compass direction the ground faces / 360 (0 north = -Z, 0.25 east = +X)' },
  { id: 'cavity', label: 'Cavity', meaning: 'how enclosed the ground is (50 m neighbourhood), 0 open .. 1' },
  { id: 'deposits', label: 'Deposits', meaning: 'sediment hydraulic erosion laid down, 0..1 of the map\'s 98th percentile' },
  { id: 'wear', label: 'Wear', meaning: 'ground hydraulic erosion cut away, 0..1 of the map\'s 98th percentile' },
  { id: 'talus', label: 'Talus', meaning: 'material thermal erosion piled at slope feet, 0..1 of the map\'s 98th percentile' },
  { id: 'water', label: 'Water', meaning: '1 under the sea or a lake, 0 on land' },
];

export interface ExportOptions {
  /** File-name prefix. */
  name?: string;
  /** Fields and surfaces already built at full resolution (the worker's); computed here otherwise. */
  fields?: WorldFields;
  surfaces?: SurfaceAlphas;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
const CHANNELS = ['r', 'g', 'b', 'a'] as const;

/** A short hash of what decides the exported files (not the preview): editors re-apply when it changes. */
export function worldExportHash(doc: WorldDoc): string {
  return fnv1a(new TextEncoder().encode(exportKey(doc)));
}

function maskPlane(id: string, out: WorldOutput, fields: WorldFields): Float32Array | null {
  const N = fields.heightM.length;
  switch (id) {
    case 'slope': case 'curvature': case 'flow': case 'wetness': return out.masks[id];
    case 'aspect': { const a = fields.aspect; if (!a) return null; const p = new Float32Array(N); for (let i = 0; i < N; i++) p[i] = a[i] / 360; return p; }
    case 'cavity': return fields.cavity.medium ?? null;
    case 'deposits': return fields.deposits;
    case 'wear': return fields.wear;
    case 'talus': return fields.talus;
    case 'water': { const p = new Float32Array(N); for (let i = 0; i < N; i++) p[i] = fields.water.kind[i] !== WATER_DRY ? 1 : 0; return p; }
    default: return null;
  }
}

export async function exportWorld(out: WorldOutput, doc: WorldDoc, opts: ExportOptions = {}): Promise<ExportFile[]> {
  const name = opts.name ?? 'world';
  const res = out.frame.resolution;
  const scale = out.frame.heightScale;
  const settings = doc.output;
  const wanted = new Set(settings.masks);
  const fields = opts.fields ?? buildFields(out, doc, { aspect: wanted.has('aspect'), cavity: wanted.has('cavity') ? ['medium'] : [] });
  const { image, min, max } = imageFromHeights(out.heights, res);
  const files: ExportFile[] = [
    { name: `${name}_height.png`, mime: 'image/png', bytes: await encodePng16(image) },
    { name: `${name}_height.r16`, mime: 'application/octet-stream', bytes: encodeRaw16(image) },
  ];
  if (settings.exr) files.push({ name: `${name}_height.exr`, mime: 'image/x-exr', bytes: encodeExrFloat(res, res, fields.heightM) });

  const masks: Record<string, { file: string; bits: number; meaning: string }> = {};
  // The four classic masks first, in their historical order; then the rest.
  const order = [...MASK_KINDS, ...EXPORT_MASKS.map(m => m.id).filter(id => !(MASK_KINDS as readonly string[]).includes(id))];
  for (const id of order) {
    if (!wanted.has(id)) continue;
    const plane = maskPlane(id, out, fields);
    if (!plane) continue;
    const file = `${name}_${id}.png`;
    const bytes = settings.masks16 ? await encodePng16({ width: res, height: res, data: plane }) : await encodePngGray8(res, res, plane);
    files.push({ name: file, mime: 'image/png', bytes });
    masks[id] = { file, bits: settings.masks16 ? 16 : 8, meaning: EXPORT_MASKS.find(m => m.id === id)?.meaning ?? '' };
  }

  // Surfaces: the enabled layers, bottom to top, as normalised weights.
  const M = settings.splatResolution;
  const surfaces = opts.surfaces?.size === M ? opts.surfaces : buildSurfaces(fields, doc, M);
  const enabled = doc.surfaces.map((s, i) => ({ s, alpha: surfaces.alphas[i] })).filter(e => e.alpha) as { s: WorldDoc['surfaces'][number]; alpha: Uint8Array }[];
  const weights = alphasToWeights(enabled.map(e => e.alpha), M);
  const shares = coverage(weights);
  const splatFiles: string[] = [];
  if (settings.splat) {
    const images = packSplat(weights, M);
    for (let k = 0; k < images.length; k++) {
      const file = `${name}_splat_${k}.png`;
      files.push({ name: file, mime: 'image/png', bytes: await encodePngRgba8(M, M, images[k]) });
      splatFiles.push(file);
    }
  }
  const layers = [];
  for (let i = 0; i < enabled.length; i++) {
    const { s } = enabled[i];
    let weightmap: string | undefined;
    if (settings.weightmaps) {
      weightmap = `${name}_weight_${String(i).padStart(2, '0')}_${slug(s.name)}.png`;
      files.push({ name: weightmap, mime: 'image/png', bytes: await encodePngGray8Bytes(M, M, weights[i]) });
    }
    const info = surfaceKindInfo(s.preview.kind);
    layers.push({
      id: s.id, name: s.name, index: i,
      ...(settings.splat ? { splat: { file: splatFiles[i >> 2], channel: CHANNELS[i & 3] } } : {}),
      ...(weightmap ? { weightmap } : {}),
      coverage: Math.round(shares[i] * 10000) / 10000,
      kind: s.preview.kind,
      color: info.color.map((c, j) => Math.round(c * s.preview.tint[j] * 1000) / 1000),
    });
  }

  const water = fields.water;
  const cell = fields.cell;
  const half = out.frame.size / 2;
  // The document minus how the Creator previews it: enough to regenerate every file bit for bit.
  const { preview: _preview, ...params } = doc;
  const meta = sidecar('world', params, doc.settings.seed, {
    format: 'cleo-world',
    version: 2,
    resolution: res,
    size: out.frame.size,
    // World heights of a 0 and a 1 sample, for an import's Min/Max (read by every Cleo version).
    minHeight: min * scale,
    maxHeight: max * scale,
    seaLevel: doc.settings.seaLevel * scale,
    files: [...files.map(f => f.name), `${name}.json`],
    orientation: 'row 0 is the -Z edge, column 0 the -X edge (the engine heightmap convention)',
    heightmap: {
      png: `${name}_height.png`, raw: `${name}_height.r16`, ...(settings.exr ? { exr: `${name}_height.exr` } : {}),
      bits: 16, min: min * scale, max: max * scale, sampling: 'vertex-aligned: sample 0 on the -X/-Z corner',
    },
    splat: {
      resolution: M, files: splatFiles, weights: 'normalized',
      sampling: 'texel-centred; row 0 is the -Z edge, column 0 the -X edge',
    },
    layers,
    masks,
    water: {
      seaLevel: doc.settings.seaLevel * scale,
      lakes: water.lakes.map(l => ({
        level: Math.round(l.level * 100) / 100, area: Math.round(l.area),
        // World-space x/z bounds of the lake's cells.
        bounds: [-half + l.bounds[0] * cell, -half + l.bounds[1] * cell, -half + l.bounds[2] * cell, -half + l.bounds[3] * cell],
      })),
    },
    exportHash: worldExportHash(doc),
  });
  meta.name = `${name}.json`;
  files.push(meta);
  return files;
}
