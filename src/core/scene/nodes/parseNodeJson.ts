import { Node } from "./node";
import { setChildParser } from "./childParser";
import { ModelNode } from "./modelNode";
import { LodGroupNode } from "./lodGroupNode";
import { CameraRigNode } from "./cameraRigNode";
import { LandscapeNode } from "./landscapeNode";
import { TilemapNode } from "./tilemapNode";
import { LightNode } from "./lightNode";
import { LightProbeNode } from "./lightProbeNode";
import { SkyboxNode } from "./skyboxNode";
import { VolumetricCloudsNode } from "./volumetricCloudsNode";
import { SkyAtmosphereNode } from "./skyAtmosphereNode";
import { CameraNode } from "./cameraNode";
import { SpriteNode } from "./spriteNode";
import { AnimatedSpriteNode } from "./animatedSpriteNode";
import { UIRootNode } from "./ui/uiRoot";
import { UIPanelNode, UIStackNode, UISpacerNode } from "./ui/uiContainers";
import { UITextNode, UIImageNode } from "./ui/uiContent";
import { UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode } from "./ui/uiWidgets";

/**
 * Reconstruct a serialized subtree under `parent`, dispatching on its `type`.
 *
 * `Node.parse` alone always builds a plain Node, so anything routed through it loses its subclass — a model
 * comes back as an empty transform. Every path that materializes a subtree (scene parse, runtime
 * `Scene.instantiate`, the editor's template/model instantiation) goes through here, so a new node type is
 * registered in exactly one place. `ModelNode.parse` detects animated vs static models itself, so skinned
 * meshes round-trip through the single `'model'` case.
 *
 * Kept as an exhaustive `switch` rather than a lookup table on purpose: one visible list of every type the
 * engine can rebuild is worth more than the indirection would save, and a missing case is obvious here in a
 * way a missing registration call would not be.
 *
 * This module is the top of the node graph — it imports every subclass and nothing imports it back. The
 * `setChildParser` call below is what lets the base class recurse into children without knowing any of
 * them; it rides along with the import rather than needing a side-effect-only import somewhere, because
 * both `scene.ts` and the `cleo` barrel already import `parseNodeJson` by name.
 */
export function parseNodeJson(parent: Node, json: any): void {
  switch (json?.type) {
    case 'model': ModelNode.parse(parent, json); break;
    case 'light': LightNode.parse(parent, json); break;
    case 'lightProbe': LightProbeNode.parse(parent, json); break;
    case 'skybox': SkyboxNode.parse(parent, json); break;
    case 'camera': CameraNode.parse(parent, json); break;
    case 'sprite': SpriteNode.parse(parent, json); break;
    case 'animatedSprite': AnimatedSpriteNode.parse(parent, json); break;
    case 'landscape': LandscapeNode.parse(parent, json); break;
    case 'tilemap': TilemapNode.parse(parent, json); break;
    case 'volumetricClouds': VolumetricCloudsNode.parse(parent, json); break;
    case 'skyAtmosphere': SkyAtmosphereNode.parse(parent, json); break;
    case 'lodGroup': LodGroupNode.parse(parent, json); break;
    case 'cameraRig': CameraRigNode.parse(parent, json); break;
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
    default: Node.parse(parent, json);
  }
}

setChildParser(parseNodeJson);
