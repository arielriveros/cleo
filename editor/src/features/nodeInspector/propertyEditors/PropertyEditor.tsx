import { Node, ModelNode, SkyboxNode, LightNode, LightProbeNode, CameraNode, CameraRigNode, SpriteNode, TilemapNode, LandscapeNode, VolumetricCloudsNode, SkyAtmosphereNode, UINode, UIRootNode, isUINodeType, SkyLightNode, SoundNode } from 'cleo'
import MaterialSlot from './MaterialSlot'
import AnimationSlot from './AnimationSlot'
import ModelSlot from './ModelSlot'
import SkyboxEditor from './SkyboxEditor'
import TransformEditor from './TransformEditor'
import LightEditor from './LightEditor'
import LightProbeEditor from './LightProbeEditor'
import NodeInfo from './NodeInfo'
import CameraEditor from './CameraEditor'
import SpriteEditor from './SpriteEditor'
import AnimatedSpriteEditor from './SpriteSheetEditor'
import VolumetricCloudsEditor from './VolumetricCloudsEditor'
import SkyAtmosphereEditor from './SkyAtmosphereEditor'
import SkyLightEditor from './SkyLightEditor'
import CameraRigEditor from './CameraRigEditor'
import SoundEditor from './SoundEditor'
import TilemapEditor from './TilemapEditor'
import LandscapeEditor from './LandscapeEditor'
import SceneSettings from './SceneSettings'
import UIEditor from './UIEditor'
import { isRootNode } from '../useSelectedNode'
import { useCleoEngine } from '../../EngineContext'

export default function PropertyEditor(props: {node: Node, readOnly?: boolean}) {
  const { activeTab } = useCleoEngine();
  const root = isRootNode(props.node);
  const ro = !!props.readOnly;
  // A screen-space UI element has no meaningful world transform: the anchor solve owns its position. A
  // WORLD-space canvas is the exception — its `position` is the point it projects from.
  const isUI = isUINodeType(props.node.nodeType);
  const showTransform = !root && (!isUI || (props.node instanceof UIRootNode && props.node.space === 'world'));

  // Gated on the tab kind: a template/model tab's throwaway scene also has a root named 'root', and that
  // one is not a scene asset.
  if (root && activeTab.kind === 'scene') return <SceneSettings />;

  return (
    <>
        {/* NodeInfo (name locked, Delete kept) and Transform stay editable for instances. */}
        <NodeInfo node={props.node} readOnly={ro} />
        {showTransform && <TransformEditor node={props.node} />}

        {/* Which model asset this subtree came from. Outside the fieldset below on purpose: it is a label
            and a navigation button, not an edit, and jumping to the asset is exactly what you want from a
            read-only template instance. Renders itself away for anything not placed from a model. */}
        {!root && <ModelSlot node={props.node} />}

        {/* Everything else is disabled in one shot for a template instance. */}
        <fieldset disabled={ro} className={`${ro ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`}>
          { props.node.nodeType === 'model' && <MaterialSlot node={props.node as ModelNode} /> }
          {/* Any node that IS or CONTAINS a skinned model — AnimationSlot finds it in the subtree and renders
              away otherwise, so selecting a character's holder root (e.g. inside a template) shows it too. */}
          { !root && <AnimationSlot node={props.node} /> }
          { props.node.nodeType === 'sprite' && <SpriteEditor node={props.node as SpriteNode} /> }
          { props.node.nodeType === 'animatedSprite' && <AnimatedSpriteEditor /> }
          { props.node.nodeType === 'light' && <LightEditor node={props.node as LightNode} /> }
          { props.node.nodeType === 'lightProbe' && <LightProbeEditor node={props.node as LightProbeNode} /> }
          { props.node.nodeType === 'skybox' && <SkyboxEditor node={props.node as SkyboxNode} /> }
          { props.node.nodeType === 'camera' && <CameraEditor node={props.node as CameraNode} /> }
          { props.node.nodeType === 'cameraRig' && <CameraRigEditor node={props.node as CameraRigNode} /> }
          { props.node.nodeType === 'sound' && <SoundEditor node={props.node as SoundNode} /> }
          { props.node.nodeType === 'tilemap' && <TilemapEditor node={props.node as TilemapNode} /> }
          { props.node.nodeType === 'landscape' && <LandscapeEditor key={props.node.id} node={props.node as LandscapeNode} /> }
          { props.node.nodeType === 'volumetricClouds' && <VolumetricCloudsEditor node={props.node as VolumetricCloudsNode} /> }
          { props.node.nodeType === 'skyAtmosphere' && <SkyAtmosphereEditor node={props.node as SkyAtmosphereNode} /> }
          { props.node.nodeType === 'skyLight' && <SkyLightEditor node={props.node as SkyLightNode} /> }
          { isUI && <UIEditor node={props.node as UINode} /> }
        </fieldset>
    </>
  )
}
