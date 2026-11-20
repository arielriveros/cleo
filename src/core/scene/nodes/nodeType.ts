/**
 * The node type registry: the discriminator every serialized node carries in its `type` field.
 *
 * Must stay a leaf with no imports — it sits at the bottom of a module graph full of cycles.
 * The string values are persisted in saved scenes and compared as literals by the editor: adding one is
 * safe, renaming one is not.
 */


export type NodeType = 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite' | 'landscape' | 'tilemap' | 'volumetricClouds' | 'skyAtmosphere' | 'skyLight' | 'wind' | 'weather' | 'lodGroup' | 'cameraRig' | 'sound' | 'character' | 'controller' | 'navMesh' | 'decal'
  | 'particleSystem' | 'forceField' | 'waterVolume' | 'occlusionVolume' | 'exposureVolume' | 'volumetricFog' | 'fluidVolume' | 'cloth' | 'giVolume'
  | 'sequence'
  | 'camera2D' | 'room2D' | 'parallaxLayer' | 'characterBody2D' | 'body2D' | 'area2D'
  | 'collider' | 'trigger' | 'vehicle' | 'wheel'
  | 'uiRoot' | 'uiPanel' | 'uiText' | 'uiImage' | 'uiButton' | 'uiStack' | 'uiSpacer'
  | 'uiProgressBar' | 'uiSlider' | 'uiToggle' | 'uiTextInput';

/** The UI node family — every type whose layout is resolved by the scene's UI pass. */
const UI_NODE_TYPES: ReadonlySet<string> = new Set<NodeType>([
  'uiRoot', 'uiPanel', 'uiText', 'uiImage', 'uiButton', 'uiStack', 'uiSpacer',
  'uiProgressBar', 'uiSlider', 'uiToggle', 'uiTextInput',
]);

/** Whether a serialized `type` string belongs to the UI family. */
export function isUINodeType(type: string): boolean { return UI_NODE_TYPES.has(type); }

// Guards for node classes that live in optional features (src/modules/<id>): the core asks by type rather than with
// `instanceof`, which would import the class and so the feature into every game.
import type { CharacterBody2DNode } from './characterBody2DNode';
import type { Camera2DNode } from './camera2DNode';
import type { VehicleNode } from './vehicleNode';

/** A 2D character body (feature `physics2d`). */
export function isCharacterBody2D(node: unknown): node is CharacterBody2DNode {
  return (node as { nodeType?: unknown } | null | undefined)?.nodeType === 'characterBody2D';
}

/** A 2D camera (feature `world2d`). */
export function isCamera2D(node: unknown): node is Camera2DNode {
  return (node as { nodeType?: unknown } | null | undefined)?.nodeType === 'camera2D';
}

/** A vehicle (feature `vehicles`): a controller may possess one. */
export function isVehicle(node: unknown): node is VehicleNode {
  return (node as { nodeType?: unknown } | null | undefined)?.nodeType === 'vehicle';
}
