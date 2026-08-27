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
import { SkyLightNode } from "./skyLightNode";
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
 * Every path that materializes a subtree must route through here: `Node.parse` alone builds a plain Node
 * and drops the subclass. This module is the top of the node graph — it imports every subclass and nothing
 * imports it back, which is why the `setChildParser` wiring below lives here.
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
    case 'skyLight': SkyLightNode.parse(parent, json); break;
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
