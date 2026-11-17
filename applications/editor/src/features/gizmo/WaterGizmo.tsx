import { useEffect } from 'react';
import { WaterVolumeNode } from 'cleo';
import WaterShapeGizmoView from '@cleo/app-kit/gizmo/WaterShapeGizmo';
import { useCleoEngine } from '../EngineContext';
import { usePlayback } from '../PlaybackContext';
import { isWithinTemplateInstance } from '../../utils/templates';
import { WATER_SHAPES_EDITED, setWaterShapeSelection, useWaterShapeSelection } from './waterSelection';

/**
 * The editor's handles for the selected Water node's body: app-kit's context-free WaterShapeGizmo (see its
 * header), outside Play and outside a template instance. Every change announces SCENE_CHANGED and
 * WATER_SHAPES_EDITED.
 */

interface Props {
  selectedNodeId: string | null;
  viewportRef: React.RefObject<HTMLDivElement>;
}

export default function WaterGizmo({ selectedNodeId, viewportRef }: Props) {
  const { instance, editorScene, eventEmitter, editorMode } = useCleoEngine();
  const { isPlayMode } = usePlayback();
  const selection = useWaterShapeSelection(eventEmitter);

  const found = selectedNodeId && editorScene ? editorScene.getNodeById(selectedNodeId) : null;
  const node = found instanceof WaterVolumeNode ? found : null;
  const readOnly = editorMode === 'scene' && !!node && isWithinTemplateInstance(node);
  const mine = selection && node && selection.nodeId === node.id ? selection : null;

  // Selecting another node (or none) drops the point selection.
  useEffect(() => {
    if (selection && selection.nodeId !== selectedNodeId) setWaterShapeSelection(eventEmitter, null);
  }, [selectedNodeId]);

  return <WaterShapeGizmoView instance={instance} bus={eventEmitter} node={node}
    selectedPoint={mine ? mine.point : -1}
    onSelectPoint={point => setWaterShapeSelection(eventEmitter, node && point >= 0 ? { nodeId: node.id, point } : null)}
    active={!!node && !isPlayMode && !readOnly} viewportRef={viewportRef}
    onEdited={n => {
      eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: n });
      eventEmitter.emit(WATER_SHAPES_EDITED, { nodeId: n.id });
    }} />;
}
