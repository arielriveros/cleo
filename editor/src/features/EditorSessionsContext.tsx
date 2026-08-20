import { createContext, useContext } from 'react';
import type { useCleoEngine } from './EngineContext';

type EngineValue = ReturnType<typeof useCleoEngine>;

/**
 * The sub-editor "authoring session" slice: everything for entering and driving the template, material,
 * terrain-material, animation, model and script editors — split out of the large EngineContext.
 *
 * Grouped into one context rather than six because each sub-editor's session is small, they are never
 * used together by the same consumer, and they share one shape: an `enter*Editor` that opens a tab plus
 * the `editing*`/session state describing what that tab is editing. (The animation state-machine editing
 * session already has its own provider — StateMachineContext — which layers on top of this.)
 *
 * Derived via `Pick` so the signatures stay in lockstep with the context they are lifted from.
 */
export type EditorSessionsContextValue = Pick<EngineValue,
  // Template
  | 'enterTemplateEditor' | 'editingTemplateName' | 'templateRootId'
  // Material
  | 'enterMaterialEditor' | 'createMaterialForNode' | 'editingMaterialName' | 'setActiveMaterialName'
  // Terrain material
  | 'enterTerrainMaterialEditor' | 'editingTerrainMaterialName' | 'editingTerrainMaterialNode'
  | 'refreshTerrainMaterialPreview' | 'setActiveTerrainMaterialName'
  // Animation
  | 'enterAnimationEditor' | 'animationTargetId' | 'animationSourceId' | 'animationSourceScene'
  | 'commitAnimationStateMachine' | 'registerAnimationApply'
  | 'importAnimationFiles' | 'importSkeletonNames' | 'renameAnimationClip' | 'removeAnimationClip'
  | 'pendingAnimationImport' | 'resolveAnimationImport'
  | 'pendingRigPick' | 'resolveRigPick'
  // Model
  | 'enterModelEditor' | 'modelSession' | 'modelEditTargetId' | 'setActiveModelName'
  | 'addModelLodFromAsset' | 'removeModelLod' | 'setModelLodDistance' | 'setModelCullDistance'
  | 'setActiveModelLevel' | 'importModelFiles' | 'pendingModelImport' | 'resolveModelImport'
  // Script
  | 'enterScriptEditor' | 'setScriptTabSource' | 'getScriptTabSource' | 'saveScriptSource'
  | 'scriptAssetOf' | 'createScriptForNode' | 'attachScriptToNode' | 'detachScriptFromNode'
  // Animation field (blend space)
  | 'enterAnimationFieldEditor' | 'createAnimationFieldForModel' | 'saveAnimationField'
  | 'editingAnimationFieldId' | 'animationFieldTargetId'
>;

export const EditorSessionsContext = createContext<EditorSessionsContextValue | null>(null);

/** Read the sub-editor session slice. Provided by EngineProvider. */
export function useEditorSessions(): EditorSessionsContextValue {
  const ctx = useContext(EditorSessionsContext);
  if (!ctx) throw new Error('useEditorSessions must be used within an EngineProvider');
  return ctx;
}
