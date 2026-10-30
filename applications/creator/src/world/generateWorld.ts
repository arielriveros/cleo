// World Creator's generate(): evaluate the landform stack, run the erosion passes, derive the masks.
// A deterministic function of the document (its settings carry the seed).

import { encodePng16, encodeRaw16, imageFromHeights } from 'cleo/terrain/heightmapIO';
import { encodePngGray8 } from '../core/png';
import { SILENT_CONTEXT, sidecar, type ExportFile, type GenerateContext } from '../core/generator';
import { applyLayer } from './features';
import { dropletErosion, pipeErosion, thermalErosion, type PipeMasks, type PipeParams, type WorldFrame } from './erosion';
import { computeMasks, MASK_KINDS, type WorldMasks } from './masks';
import type { WorldDoc } from './worldDoc';

export interface WorldOutput {
  frame: WorldFrame;
  /** Normalised heights (a fraction of heightScale), row-major, `resolution` squared. */
  heights: Float32Array;
  masks: WorldMasks;
  /** Which path the pipe erosion took, for the status line. */
  pipeBackend: 'gpu' | 'cpu' | null;
}

/** A GPU implementation of the pipe pass, injected by the app when the engine's device has compute. */
export type PipeErosionGpu = (h: Float32Array, f: WorldFrame, p: PipeParams, ctx: GenerateContext) => Promise<PipeMasks>;

export interface GenerateWorldOptions {
  /** Override the document's resolution (the live preview runs smaller than the export). */
  resolution?: number;
  pipeGpu?: PipeErosionGpu | null;
}

export async function generateWorld(doc: WorldDoc, ctx: GenerateContext = SILENT_CONTEXT, opts: GenerateWorldOptions = {}): Promise<WorldOutput> {
  const resolution = opts.resolution ?? doc.settings.resolution;
  const frame: WorldFrame = { resolution, size: doc.settings.size, heightScale: doc.settings.heightScale };
  const heights = new Float32Array(resolution * resolution);
  const grid = { resolution, seed: doc.settings.seed };

  const layers = doc.layers.filter(l => l.enabled);
  const passes = doc.erosion.filter(p => p.enabled);
  const steps = layers.length + passes.length + 1;
  let step = 0;
  const sub = (label: string): GenerateContext => {
    const base = step;
    return {
      progress: (f, l) => ctx.progress((base + f) / steps, l ?? label),
      get cancelled() { return ctx.cancelled; },
    };
  };

  for (const layer of layers) {
    ctx.progress(step / steps, layer.name);
    applyLayer(heights, grid, layer);
    step++;
  }

  let pipe: PipeMasks | null = null;
  let pipeBackend: WorldOutput['pipeBackend'] = null;
  for (const pass of passes) {
    const c = sub(pass.kind);
    switch (pass.kind) {
      case 'thermal': await thermalErosion(heights, frame, pass.params, c); break;
      case 'droplet': await dropletErosion(heights, frame, { ...pass.params, seed: pass.params.seed + doc.settings.seed * 1013 }, c); break;
      case 'pipe':
        if (opts.pipeGpu) { pipe = await opts.pipeGpu(heights, frame, pass.params, c); pipeBackend = 'gpu'; }
        else { pipe = await pipeErosion(heights, frame, pass.params, c); pipeBackend = 'cpu'; }
        break;
    }
    step++;
  }

  ctx.progress(step / steps, 'Masks');
  const masks = computeMasks(heights, frame, pipe);
  ctx.progress(1, 'Done');
  return { frame, heights, masks, pipeBackend };
}

/**
 * The export bundle: a 16-bit PNG and a RAW16 of the heights (normalised over their own range, which the
 * sidecar records), one 8-bit PNG per mask, and `world.json` with everything needed to import the
 * heightmap at the right scale -- the Editor's landscape import takes the min/max heights from it.
 */
export async function exportWorld(out: WorldOutput, doc: WorldDoc, name = 'world'): Promise<ExportFile[]> {
  const res = out.frame.resolution;
  const { image, min, max } = imageFromHeights(out.heights, res);
  const files: ExportFile[] = [
    { name: `${name}_height.png`, mime: 'image/png', bytes: await encodePng16(image) },
    { name: `${name}_height.r16`, mime: 'application/octet-stream', bytes: encodeRaw16(image) },
  ];
  for (const kind of MASK_KINDS)
    files.push({ name: `${name}_${kind}.png`, mime: 'image/png', bytes: await encodePngGray8(res, res, out.masks[kind]) });
  const meta = sidecar('world', doc, doc.settings.seed, {
    resolution: res,
    size: out.frame.size,
    // World heights of a 0 and a 1 sample, for the import dialog's Min/Max fields.
    minHeight: min * out.frame.heightScale,
    maxHeight: max * out.frame.heightScale,
    seaLevel: doc.settings.seaLevel * out.frame.heightScale,
    files: files.map(f => f.name),
    orientation: 'row 0 is the -Z edge, column 0 the -X edge (the engine heightmap convention)',
  });
  meta.name = `${name}.json`;
  files.push(meta);
  return files;
}
