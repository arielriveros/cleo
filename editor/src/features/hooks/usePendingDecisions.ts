import { useState, useRef } from 'react';
import type {
  PendingModelImportView, ModelImportDecision, PendingRigPickView, PendingAnimationImportView,
  AnimationImportDecision,
} from '../engineContextTypes';

/**
 * The park-then-resolve modal slice, lifted out of EngineProvider verbatim.
 *
 * Five independent dialogs, all built the same way: a piece of state that IS the modal's props (null when
 * it is closed), and a ref holding the promise resolver the modal settles it through. Nothing outside
 * these ten values is involved, which is why the slice takes no arguments at all — the flows that park on
 * a dialog reach in through the setter and the resolver ref returned below.
 */
export function usePendingDecisions() {
  // Mesh import review modal: importModelFiles parks each parsed mesh here and awaits the user's decision
  // (resolved by ModelImportModal via resolveModelImport). The resolver lives in a ref so the promise in
  // importModelFiles can be settled from the modal without re-rendering churn.
  const [pendingModelImport, setPendingModelImport] = useState<PendingModelImportView | null>(null);
  const pendingResolverRef = useRef<((d: ModelImportDecision | null) => void) | null>(null);
  const resolveModelImport = (decision: ModelImportDecision | null) => {
    const r = pendingResolverRef.current;
    pendingResolverRef.current = null;
    setPendingModelImport(null);
    if (r) r(decision);
  };

  // Rig picker, shown before the review modal when the import did not come from an open Animation Editor:
  // an animation file carries no character, so the rig it retargets onto has to be chosen.
  const [pendingRigPick, setPendingRigPick] = useState<PendingRigPickView | null>(null);
  const pendingRigResolverRef = useRef<((id: string | null) => void) | null>(null);
  const resolveRigPick = (modelId: string | null) => {
    const r = pendingRigResolverRef.current;
    pendingRigResolverRef.current = null;
    setPendingRigPick(null);
    if (r) r(modelId);
  };

  // Animation import review modal — same "park then resolve a promise" pattern as the mesh import.
  const [pendingAnimationImport, setPendingAnimationImport] = useState<PendingAnimationImportView | null>(null);
  const pendingAnimResolverRef = useRef<((d: AnimationImportDecision | null) => void) | null>(null);
  const resolveAnimationImport = (decision: AnimationImportDecision | null) => {
    const r = pendingAnimResolverRef.current;
    pendingAnimResolverRef.current = null;
    setPendingAnimationImport(null);
    if (r) r(decision);
  };

  // Unsaved-changes confirm dialog — same "park then resolve a promise" pattern as the import modals.
  // Two callers park here: openScene (switching away from a scene with unsaved edits) and closeTab
  // (closing a dirty asset tab). `action` only changes the wording; both resolve the same three ways.
  const [pendingSceneConfirm, setPendingSceneConfirm] = useState<{ sceneName: string; action: 'switch' | 'close' } | null>(null);
  const sceneConfirmResolverRef = useRef<((d: 'save' | 'discard' | 'cancel') => void) | null>(null);
  const confirmUnsavedScene = (sceneName: string, action: 'switch' | 'close' = 'switch'): Promise<'save' | 'discard' | 'cancel'> =>
    new Promise(resolve => {
      sceneConfirmResolverRef.current = resolve;
      setPendingSceneConfirm({ sceneName, action });
    });
  const resolveSceneConfirm = (decision: 'save' | 'discard' | 'cancel') => {
    const r = sceneConfirmResolverRef.current;
    sceneConfirmResolverRef.current = null;
    setPendingSceneConfirm(null);
    if (r) r(decision);
  };

  // Same park-then-resolve pattern, for switching a scene between 2D and 3D while it holds authoring only
  // the OTHER dimension uses. The data is kept and the switch is reversible, but a published build
  // discards it.
  const [pendingDimensionConfirm, setPendingDimensionConfirm] =
    useState<{ to: '2D' | '3D'; losing: 'tilemap' | 'landscape'; count: number } | null>(null);
  const dimensionConfirmResolverRef = useRef<((proceed: boolean) => void) | null>(null);
  const confirmDimensionSwitch = (to: '2D' | '3D', losing: 'tilemap' | 'landscape', count: number): Promise<boolean> =>
    new Promise(resolve => {
      dimensionConfirmResolverRef.current = resolve;
      setPendingDimensionConfirm({ to, losing, count });
    });
  const resolveDimensionConfirm = (proceed: boolean) => {
    const r = dimensionConfirmResolverRef.current;
    dimensionConfirmResolverRef.current = null;
    setPendingDimensionConfirm(null);
    if (r) r(proceed);
  };

  return {
    pendingModelImport, setPendingModelImport, pendingResolverRef, resolveModelImport,
    pendingRigPick, setPendingRigPick, pendingRigResolverRef, resolveRigPick,
    pendingAnimationImport, setPendingAnimationImport, pendingAnimResolverRef, resolveAnimationImport,
    pendingSceneConfirm, confirmUnsavedScene, resolveSceneConfirm,
    pendingDimensionConfirm, confirmDimensionSwitch, resolveDimensionConfirm,
  };
}
