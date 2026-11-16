import { useEffect } from 'react';
import { vec3 } from 'gl-matrix';
import { WaterVolumeNode } from 'cleo';
import WaterShapeGizmoView from '@cleo/app-kit/gizmo/WaterShapeGizmo';
import { useCleoEngine } from '../EngineContext';
import { usePlayback } from '../PlaybackContext';
import { isWithinTemplateInstance } from '../../utils/templates';
import {
  WATER_SHAPE_FRAME, WATER_SHAPES_EDITED, setWaterShapeSelection, useWaterShapeSelection, type WaterShapeRef,
} from './waterSelection';

/**
 * The editor's handles for the shapes of the selected Water node: app-kit's context-free WaterShapeGizmo
 * (see its header), outside Play and outside a template instance. Every change announces SCENE_CHANGED and
 * WATER_SHAPES_EDITED; it also answers the inspector's frame button (WATER_SHAPE_FRAME).
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

  // Selecting another node (or none) drops the shape selection.
  useEffect(() => {
    if (selection && selection.nodeId !== selectedNodeId) setWaterShapeSelection(eventEmitter, null);
  }, [selectedNodeId]);

  useEffect(() => {
    const onFrame = (ref: WaterShapeRef) => {
      const target = editorScene?.getNodeById(ref.nodeId);
      const camNode = instance?.scene?.activeCamera;
      if (!(target instanceof WaterVolumeNode) || !camNode) return;
      const r = target.resolvedShapes().find(s => s.id === ref.shapeId);
      if (!r) return;
      // An endless ocean frames the node's own 100 m around it.
      const p = target.worldPosition;
      const min = r.endless ? [p[0] - 50, r.level - 5, p[2] - 50] : r.min;
      const max = r.endless ? [p[0] + 50, r.level, p[2] + 50] : r.max;
      const centre = vec3.fromValues((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
      const radius = Math.max(0.5, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
      const cam = camNode.camera;
      const view = cam.viewMatrix;
      const back = vec3.normalize(vec3.create(), vec3.fromValues(view[2], view[6], view[10]));
      const position = cam.type === 'orthographic'
        ? vec3.fromValues(centre[0], centre[1], camNode.position[2])
        : vec3.scaleAndAdd(vec3.create(), centre, back, (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.3);
      camNode.setPosition(position);
    };
    eventEmitter.on(WATER_SHAPE_FRAME, onFrame);
    return () => { eventEmitter.off(WATER_SHAPE_FRAME, onFrame); };
  }, [eventEmitter, editorScene, instance]);

  return <WaterShapeGizmoView instance={instance} bus={eventEmitter} node={node}
    selection={mine ? { shapeId: mine.shapeId, point: mine.point } : null}
    onSelect={sel => setWaterShapeSelection(eventEmitter, sel && node ? { nodeId: node.id, shapeId: sel.shapeId, point: sel.point } : null)}
    active={!!node && !isPlayMode && !readOnly} viewportRef={viewportRef}
    onEdited={n => {
      eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: n });
      eventEmitter.emit(WATER_SHAPES_EDITED, { nodeId: n.id });
    }} />;
}
