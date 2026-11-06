// The World's stages after the terrain: fields from the heights, then the surfaces' alpha planes from the
// fields. Pure functions, so the worker, the export and the tests run exactly the same code.

import { computeFields, fieldNeeds, type ExtraNeeds, type WorldFields } from './fields';
import type { WorldOutput } from './generateWorld';
import { evaluateSurfaces, type SurfaceAlphas } from './surfaces/evaluate';
import type { WorldDoc } from './worldDoc';

export interface SurfaceBuild {
  fields: WorldFields;
  surfaces: SurfaceAlphas;
}

/** Fields for `doc`'s rules (plus `extra`), from a generated terrain. */
export function buildFields(out: WorldOutput, doc: WorldDoc, extra: ExtraNeeds = {}): WorldFields {
  return computeFields({
    frame: out.frame, heights: out.heights, masks: out.masks, history: out.history,
    seaLevel: doc.settings.seaLevel * doc.settings.heightScale, lakes: doc.water.lakes,
  }, fieldNeeds(doc.surfaces, extra));
}

/** Every enabled surface's alpha plane at `maskResolution`². */
export function buildSurfaces(fields: WorldFields, doc: WorldDoc, maskResolution: number,
                              opts: { cancelled?: () => boolean; progress?: (f: number, label: string) => void } = {}): SurfaceAlphas {
  return evaluateSurfaces(fields, doc.surfaces, maskResolution, { seed: doc.settings.seed, ...opts });
}
