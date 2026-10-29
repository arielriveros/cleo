import { StepStatus } from './progress/progressStore';

// ---- Import progress -------------------------------------------------------------------------------
// Every step importModelFiles walks a bundle through, in order. Maps onto the shared progress store's
// generic steps (features/progress).
export type ImportStage =
  | 'queued'       // not started
  | 'parsing'      // Loader: assimp/GLTF parse of the model files
  | 'review'       // parked on the user in ModelImportModal (indefinite — the bar deliberately stalls)
  | 'reparsing'    // user supplied missing textures; parse again so they wire into the materials
  | 'scaling'      // normalizeRootScale bakes the fit-to-size factor into the vertices
  | 'textures'     // waiting on async image decode before anything can be serialized
  | 'materials'    // registering a MaterialAsset per unique material
  | 'saving'       // buildModelAsset: serialize the subtree(s) into the model library
  | 'done'
  | 'failed'
  | 'skipped';     // cancelled before it ran

/** Each stage's label + how far through a bundle it is. `review` stalls: it is waiting on a human. */
export const IMPORT_STAGES: Record<ImportStage, { label: string; progress: number; status: StepStatus }> = {
  queued:    { label: 'Queued',                       progress: 0,    status: 'pending' },
  parsing:   { label: 'Parsing model',                progress: 0.15, status: 'running' },
  review:    { label: 'Waiting for you',              progress: 0.25, status: 'paused'  },
  reparsing: { label: 'Re-parsing with new textures', progress: 0.35, status: 'running' },
  scaling:   { label: 'Normalizing scale',            progress: 0.45, status: 'running' },
  textures:  { label: 'Decoding textures',            progress: 0.6,  status: 'running' },
  materials: { label: 'Registering materials',        progress: 0.8,  status: 'running' },
  saving:    { label: 'Saving to library',            progress: 0.92, status: 'running' },
  done:      { label: 'Imported',                     progress: 1,    status: 'done'    },
  failed:    { label: 'Failed',                       progress: 1,    status: 'failed'  },
  skipped:   { label: 'Skipped',                      progress: 1,    status: 'skipped' },
};
/** Stages an animation-clip import walks through. Mirrors ImportStage; `review` waits on a human. */
export type AnimImportStage = 'parsing' | 'review' | 'retargeting' | 'saving' | 'done' | 'failed' | 'skipped';
export const ANIM_IMPORT_STAGES: Record<AnimImportStage, { label: string; progress: number; status: StepStatus }> = {
  parsing:     { label: 'Reading animation',   progress: 0.15, status: 'running' },
  review:      { label: 'Waiting for you',     progress: 0.35, status: 'paused'  },
  retargeting: { label: 'Retargeting clips',   progress: 0.7,  status: 'running' },
  saving:      { label: 'Saving to library',   progress: 0.9,  status: 'running' },
  done:        { label: 'Imported',            progress: 1,    status: 'done'    },
  failed:      { label: 'Failed',              progress: 1,    status: 'failed'  },
  skipped:     { label: 'Skipped',             progress: 1,    status: 'skipped' },
};
