import { useCallback, useEffect, useRef } from 'react';
import { CameraNode, isTextEntryEvent } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { frameKeepingView } from './frameNode';

/**
 * View ▸ Frame Selected, and its F key: bring the selected node into the middle of the editing camera's
 * view without turning the camera (`frameKeepingView`). The editing camera is the scene's active camera --
 * in a split viewport, the camera of the pane being edited. Only an editor camera moves: not in Play,
 * where the game's camera is in charge. In Simulate the node is looked up in the running scene.
 *
 * `listen` installs the F key; mount it once (the menu bar does).
 */
export function useFrameSelected(listen = false): { canFrame: boolean; frameSelected: () => void } {
  const { instance, inspectedScene, selectedNode, isPlayMode, isSimulating } = useCleoEngine();
  const canFrame = !!selectedNode && (!isPlayMode || isSimulating);

  const frameSelected = useCallback(() => {
    if (!selectedNode || (isPlayMode && !isSimulating)) return;
    const scene = instance?.scene;
    const camera = scene?.activeCamera;
    if (!scene || !(camera instanceof CameraNode) || !camera.isEditorOwned) return;
    const node = inspectedScene?.getNodeById(selectedNode);
    if (!node) return;
    // World matrices and bounds catch up with an edit only in the next frame's update.
    scene.root.updateTransforms(null);
    frameKeepingView(camera, node);
  }, [instance, inspectedScene, selectedNode, isPlayMode, isSimulating]);

  // The F key: not while typing (a field, a dropdown, the code editor), with a modifier, or while a mouse
  // button is held (the camera flies then).
  const run = useRef(frameSelected);
  run.current = frameSelected;
  useEffect(() => {
    if (!listen) return;
    let buttons = 0;
    const trackButtons = (e: MouseEvent) => { buttons = e.buttons; };
    const onBlur = () => { buttons = 0; };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isTextEntryEvent(e) || buttons) return;
      run.current();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', trackButtons, true);
    window.addEventListener('mouseup', trackButtons, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', trackButtons, true);
      window.removeEventListener('mouseup', trackButtons, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [listen]);

  return { canFrame, frameSelected };
}
