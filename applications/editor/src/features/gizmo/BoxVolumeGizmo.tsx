import { ExposureVolumeNode, GIVolumeNode, LightProbeNode, MIN_EXPOSURE_VOLUME_SIZE, MIN_FOG_VOLUME_SIZE, MIN_WEATHER_VOLUME_SIZE, OcclusionVolumeNode, VolumetricFogNode, WeatherNode, type Node } from 'cleo';
import BoxVolumeGizmoView, { type VolumeTarget } from '@cleo/app-kit/gizmo/BoxVolumeGizmo';
import { useCleoEngine } from '../EngineContext';
import { usePlayback } from '../PlaybackContext';
import { isWithinTemplateInstance } from '../../utils/templates';

/**
 * The editor's face handles for box VOLUME nodes — light probes, exposure and occlusion volumes: app-kit's
 * context-free box gizmo (see its header), on the selected node when it is one, outside Play and outside
 * a template instance. Every change announces SCENE_CHANGED and BOX_VOLUME_EDITED.
 */

/** Announced on every change a handle makes, so an open inspector re-reads the size it shows. */
export const BOX_VOLUME_EDITED = 'BOX_VOLUME_EDITED';

/** What the handles edit on a node, or null when it is not a box volume (or an unbounded probe). */
export function boxVolumeTarget(node: Node | null | undefined): VolumeTarget | null {
  if (node instanceof ExposureVolumeNode) {
    return { size: () => [...node.size] as [number, number, number], setSize: s => { node.size = s; }, minSize: MIN_EXPOSURE_VOLUME_SIZE };
  }
  // A GI volume: grown past a room's walls, or over a street.
  if (node instanceof GIVolumeNode) {
    return { size: () => [...node.size] as [number, number, number], setSize: s => { node.size = s; }, minSize: 0.01 };
  }
  // A bank of fog: dragged out over the pond, down into a valley floor, in to a room's walls.
  if (node instanceof VolumetricFogNode) {
    return { size: () => [...node.size] as [number, number, number], setSize: s => { node.size = s; }, minSize: MIN_FOG_VOLUME_SIZE };
  }
  // Rain or snow over part of the map. An unbounded one (size [0, 0, 0]) covers the scene: no box to grab.
  if (node instanceof WeatherNode && node.bounded) {
    return { size: () => [...node.size] as [number, number, number], setSize: s => { node.size = s; }, minSize: MIN_WEATHER_VOLUME_SIZE };
  }
  // Fitted to a room's interior by dragging its faces in to the walls.
  if (node instanceof OcclusionVolumeNode) {
    return { size: () => [...node.size] as [number, number, number], setSize: s => { node.size = s; }, minSize: 0.01 };
  }
  // An unbounded probe (any side 0) has no box to grab: it covers the whole scene.
  if (node instanceof LightProbeNode && node.bounded) {
    return { size: () => [...node.size] as [number, number, number], setSize: s => { node.size = s; }, minSize: 0.01 };
  }
  return null;
}

interface Props {
  selectedNodeId: string | null;
  viewportRef: React.RefObject<HTMLDivElement>;
}

export default function BoxVolumeGizmo({ selectedNodeId, viewportRef }: Props) {
  const { instance, editorScene, eventEmitter, editorMode } = useCleoEngine();
  const { isPlayMode } = usePlayback();

  const node = selectedNodeId && editorScene ? editorScene.getNodeById(selectedNodeId) ?? null : null;
  const readOnly = editorMode === 'scene' && !!node && isWithinTemplateInstance(node);
  const target = boxVolumeTarget(node);

  return <BoxVolumeGizmoView instance={instance} bus={eventEmitter} node={node} target={target}
                             active={!!node && !isPlayMode && !readOnly && !!target} viewportRef={viewportRef}
                             onEdited={n => {
                               eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: n });
                               eventEmitter.emit(BOX_VOLUME_EDITED, { nodeId: n.id });
                             }} />;
}
