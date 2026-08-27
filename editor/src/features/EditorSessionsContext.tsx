import { createContext, useContext } from 'react';
import type { useCleoEngine } from './EngineContext';

type EngineValue = ReturnType<typeof useCleoEngine>;

/**
 * The sub-editor "authoring session" slice: everything for entering and driving the template, material,
 * terrain-material, animation, model and script editors. One context rather than six — every session has
 * the same shape: an `enter*Editor` that opens a tab, plus the `editing*` state describing what it edits.
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
  | 'linkAnimationToModel' | 'unlinkAnimationFromModel' | 'editSharedClip'
  // Model
  | 'enterModelEditor' | 'adoptModelAsset' | 'resolveModelAssetId' | 'modelSession' | 'modelEditTargetId' | 'setActiveModelName'
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
