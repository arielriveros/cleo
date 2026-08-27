import { createContext, useContext } from 'react';
import type { useCleoEngine } from './EngineContext';

type EngineValue = ReturnType<typeof useCleoEngine>;

/**
 * The multi-scene project slice: the scene list, which scene is open / is the main one, and the
 * scene-level operations — the reactive mirror of the project meta at `cleo_project_meta`, whose
 * authoritative copy is `projectMetaRef`. The unsaved-scene confirm dialog lives here too, since it gates
 * switching the open scene. Derived via `Pick` to stay in lockstep with the context it is lifted from.
 */
export type ProjectContextValue = Pick<EngineValue,
  | 'sceneList' | 'mainSceneId' | 'openSceneId'
  | 'openScene' | 'createScene' | 'renameScene' | 'deleteScene' | 'duplicateScene' | 'setMainScene'
  | 'sceneDimension' | 'setSceneDimension'
  | 'pendingSceneConfirm' | 'resolveSceneConfirm'
  | 'pendingDimensionConfirm' | 'resolveDimensionConfirm'
  | 'replaceProjectMeta'
>;

export const ProjectContext = createContext<ProjectContextValue | null>(null);

/** Read the multi-scene project slice. Provided by EngineProvider. */
export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within an EngineProvider');
  return ctx;
}
