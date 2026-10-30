import type React from 'react'
import type { NodeType } from 'cleo'
import {
  EmptyIcon, ModelIcon, DirectionalLightIcon, LightProbeIcon, CameraIcon, CameraRigIcon,
  CharacterAddIcon, ControllerAddIcon, NavMeshIcon, SpriteIcon, AnimatedSpriteIcon, SoundIcon,
} from './nodeIcons'

// The node types a node can be CONVERTED into, indexed by node type.
//
// A separate table from ADD_ITEMS on purpose: that one is indexed by add-item id and is many-to-one onto
// types (three lights, two cameras, seventeen primitives), which is the wrong axis for "what could this
// node be instead". It does borrow from it — `defaultFrom` names the add item whose `create()` supplies a
// fresh payload for the new type — so the two stay in step without either importing the other's table.

export interface NodeTypeOption {
  nodeType: NodeType
  label: string
  /** An inline SVG glyph, following `currentColor` like the rest of the editor's chrome. */
  icon: React.ComponentType
  /** ADD_ITEMS id whose `create()` seeds this type's default payload, or null when its `parse` needs none. */
  defaultFrom: string | null
}

/**
 * `NodeType` minus two families:
 *   - the UI nodes, whose layout is only resolved inside a UIRootNode subtree, so a bare uiPanel is inert;
 *   - the scene singletons (skybox, skyAtmosphere, skyLight, volumetricClouds, landscape, tilemap), which
 *     the scene owns exactly one of and which mean nothing as a placeable template.
 *
 * `lodGroup` is left out too, for a different reason: LodGroupNode._afterParse applies the active LOD,
 * hiding every child but the first — converting a populated node into one looks like data loss.
 *
 * Three entries MUST carry a `defaultFrom`, because their parse throws on a payload-less blob: `model`
 * dereferences json.model.skin, `light` has a `default: throw` on json.lightType, and `camera` reads
 * json.camera.type. The rest tolerate one but are routed through the catalog anyway so a converted node
 * matches what the Add palette would have produced.
 */
export const CONVERTIBLE_NODE_TYPES: NodeTypeOption[] = [
  { nodeType: 'node', label: 'Empty', icon: EmptyIcon, defaultFrom: null },
  { nodeType: 'model', label: 'Model', icon: ModelIcon, defaultFrom: 'cube' },
  { nodeType: 'character', label: 'Character', icon: CharacterAddIcon, defaultFrom: 'character' },
  { nodeType: 'controller', label: 'Controller', icon: ControllerAddIcon, defaultFrom: 'controller' },
  { nodeType: 'camera', label: 'Camera', icon: CameraIcon, defaultFrom: 'perspectiveCamera' },
  { nodeType: 'cameraRig', label: 'Camera Rig', icon: CameraRigIcon, defaultFrom: 'cameraRig' },
  { nodeType: 'light', label: 'Light', icon: DirectionalLightIcon, defaultFrom: 'directionalLight' },
  { nodeType: 'lightProbe', label: 'Light Probe', icon: LightProbeIcon, defaultFrom: 'lightProbe' },
  { nodeType: 'sprite', label: 'Sprite', icon: SpriteIcon, defaultFrom: 'sprite' },
  { nodeType: 'animatedSprite', label: 'Animated Sprite', icon: AnimatedSpriteIcon, defaultFrom: 'animatedSprite' },
  { nodeType: 'sound', label: 'Sound', icon: SoundIcon, defaultFrom: 'spatialSound' },
  { nodeType: 'navMesh', label: 'Nav Mesh', icon: NavMeshIcon, defaultFrom: 'navMesh' },
]

export function findNodeTypeOption(nodeType: string): NodeTypeOption | undefined {
  return CONVERTIBLE_NODE_TYPES.find(option => option.nodeType === nodeType)
}

/** Display name for ANY node type, convertible or not — skybox and the UI family included. */
export function nodeTypeLabel(nodeType: string): string {
  return findNodeTypeOption(nodeType)?.label ?? nodeType.charAt(0).toUpperCase() + nodeType.slice(1)
}
