import { Node } from "./node";
import { setChildParser } from "./childParser";
import { ModelNode } from "./modelNode";
import { LodGroupNode } from "./lodGroupNode";
import { CameraRigNode } from "./cameraRigNode";
import { CharacterNode } from "./characterNode";
import { ControllerNode } from "./controllerNode";
import { NavMeshNode } from "./navMeshNode";
import { LandscapeNode } from "./landscapeNode";
import { TilemapNode } from "./tilemapNode";
import { LightNode } from "./lightNode";
import { LightProbeNode } from "./lightProbeNode";
import { SkyboxNode } from "./skyboxNode";
import { SkyAtmosphereNode } from "./skyAtmosphereNode";
import { SkyLightNode } from "./skyLightNode";
import { WindNode } from "./windNode";
import { WeatherNode } from "./weatherNode";
import { OcclusionVolumeNode } from "./occlusionVolumeNode";
import { CameraNode } from "./cameraNode";
import { SpriteNode } from "./spriteNode";
import { AnimatedSpriteNode } from "./animatedSpriteNode";
import { SoundNode } from "./soundNode";
import { ParticleSystemNode } from "./particleSystemNode";
import { ForceFieldNode } from "./forceFieldNode";
import { ExposureVolumeNode } from "./exposureVolumeNode";
import { Camera2DNode } from "./camera2DNode";
import { Room2DNode } from "./room2DNode";
import { ParallaxLayerNode } from "./parallaxLayerNode";
import { CharacterBody2DNode } from "./characterBody2DNode";
import { migrateLegacyBody2DJson } from "./body2DLegacy";
import { Body2DNode } from "./body2DNode";
import { ColliderNode } from "./colliderNode";
import { TriggerNode } from "./triggerNode";
import { migrateLegacyPhysicsJson } from "./physicsLegacy";
import { featureNodeParser, isFeatureRestrictedOut } from "../../features/registry";
import { featureOfNodeType } from "../../../modules/catalog";
import { Logger } from "../../logger";
import { UIRootNode } from "./ui/uiRoot";
import { UIPanelNode, UIStackNode, UISpacerNode } from "./ui/uiContainers";
import { UITextNode, UIImageNode } from "./ui/uiContent";
import { UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode } from "./ui/uiWidgets";

/**
 * Reconstruct a serialized subtree under `parent`, dispatching on its `type`.
 *
 * Every path that materializes a subtree must route through here: `Node.parse` alone builds a plain Node
 * and drops the subclass. This module is the top of the node graph — it imports every subclass and nothing
 * imports it back, which is why the `setChildParser` wiring below lives here.
 */
export function parseNodeJson(parent: Node, json: any): void {
  // Physics saved as node properties (a `body`, a `trigger`, an Area 2D) becomes Collider and Trigger nodes.
  json = migrateLegacyPhysicsJson(json);
  switch (json?.type) {
    case 'model': ModelNode.parse(parent, json); break;
    case 'light': LightNode.parse(parent, json); break;
    case 'lightProbe': LightProbeNode.parse(parent, json); break;
    case 'skybox': SkyboxNode.parse(parent, json); break;
    case 'camera': CameraNode.parse(parent, json); break;
    case 'sprite': SpriteNode.parse(parent, json); break;
    case 'animatedSprite': AnimatedSpriteNode.parse(parent, json); break;
    case 'sound': SoundNode.parse(parent, json); break;
    case 'landscape': LandscapeNode.parse(parent, json); break;
    case 'tilemap': TilemapNode.parse(parent, json); break;
    case 'skyAtmosphere': SkyAtmosphereNode.parse(parent, json); break;
    case 'skyLight': SkyLightNode.parse(parent, json); break;
    case 'wind': WindNode.parse(parent, json); break;
    case 'weather': WeatherNode.parse(parent, json); break;
    case 'occlusionVolume': OcclusionVolumeNode.parse(parent, json); break;
    // Saved before occluders became occlusion volumes (see OcclusionVolumeNode.parseLegacyOccluder).
    case 'occluder': OcclusionVolumeNode.parseLegacyOccluder(parent, json); break;
    case 'lodGroup': LodGroupNode.parse(parent, json); break;
    case 'cameraRig': CameraRigNode.parse(parent, json); break;
    case 'character': CharacterNode.parse(parent, json); break;
    case 'controller': ControllerNode.parse(parent, json); break;
    case 'navMesh': NavMeshNode.parse(parent, json); break;
    case 'particleSystem': ParticleSystemNode.parse(parent, json); break;
    case 'forceField': ForceFieldNode.parse(parent, json); break;
    case 'exposureVolume': ExposureVolumeNode.parse(parent, json); break;
    case 'camera2D': Camera2DNode.parse(parent, json); break;
    case 'room2D': Room2DNode.parse(parent, json); break;
    case 'parallaxLayer': ParallaxLayerNode.parse(parent, json); break;
    case 'characterBody2D': CharacterBody2DNode.parse(parent, migrateLegacyBody2DJson(json)); break;
    case 'body2D': Body2DNode.parse(parent, json); break;
    case 'collider': ColliderNode.parse(parent, json); break;
    case 'trigger': TriggerNode.parse(parent, json); break;
    case 'uiRoot': UIRootNode.parse(parent, json); break;
    case 'uiPanel': UIPanelNode.parse(parent, json); break;
    case 'uiText': UITextNode.parse(parent, json); break;
    case 'uiImage': UIImageNode.parse(parent, json); break;
    case 'uiButton': UIButtonNode.parse(parent, json); break;
    case 'uiStack': UIStackNode.parse(parent, json); break;
    case 'uiSpacer': UISpacerNode.parse(parent, json); break;
    case 'uiProgressBar': UIProgressBarNode.parse(parent, json); break;
    case 'uiSlider': UISliderNode.parse(parent, json); break;
    case 'uiToggle': UIToggleNode.parse(parent, json); break;
    case 'uiTextInput': UITextInputNode.parse(parent, json); break;
    default: parseOptionalNode(parent, json);
  }
}

/** Types already reported as belonging to a feature that is not installed (once each). */
const reportedMissing = new Set<string>();

/**
 * A type no core case knows: an optional feature's (src/core/features/registry.ts), when that feature is
 * installed; else a plain node, which keeps its children and transform. A published game built without the
 * feature never meets one (publish strips them); anywhere else a feature's type with no feature installed is a
 * build that forgot to install it, and says so.
 */
function parseOptionalNode(parent: Node, json: any): void {
  const parser = featureNodeParser(json?.type);
  if (parser) { parser.parse(parent, parser.migrate ? parser.migrate(json) : json); return; }
  const feature = typeof json?.type === 'string' ? featureOfNodeType(json.type) : undefined;
  if (feature && !isFeatureRestrictedOut(feature.id) && !reportedMissing.has(json.type)) {
    reportedMissing.add(json.type);
    Logger.error(`A '${json.type}' node needs the ${feature.label} feature, which is not installed: import src/modules/all (or the feature's module) before parsing.`, 'Scene');
  }
  Node.parse(parent, json);
}

setChildParser(parseNodeJson);
