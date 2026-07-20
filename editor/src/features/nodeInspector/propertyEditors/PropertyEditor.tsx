import { Node, ModelNode, SkyboxNode, LightNode, LightProbeNode, CameraNode, CameraRigNode, SpriteNode, VolumetricCloudsNode, SkyAtmosphereNode } from 'cleo'
import MaterialSlot from './MaterialSlot'
import AnimationSlot from './AnimationSlot'
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
import CameraRigEditor from './CameraRigEditor'
import SceneSettings from './SceneSettings'
import { isRootNode } from '../useSelectedNode'
import { useCleoEngine } from '../../EngineContext'

export default function PropertyEditor(props: {node: Node, readOnly?: boolean}) {
  const { activeTab } = useCleoEngine();
  const root = isRootNode(props.node);
  const ro = !!props.readOnly;

  // Selecting the scene tab's root means "the scene itself" — show its settings rather than an all-but-empty
  // node inspector. Gated on the tab kind: a template/mesh tab's throwaway scene has a root named 'root'
  // too, and that one is not a scene asset.
  if (root && activeTab.kind === 'scene') return <SceneSettings />;

  return (
    <>
        {/* NodeInfo (name locked, Delete kept) and Transform stay editable for instances. */}
        <NodeInfo node={props.node} readOnly={ro} />
        {!root && <TransformEditor node={props.node} />}

        {/* Everything else is disabled in one shot for a template instance. */}
        <fieldset disabled={ro} className={`${ro ? 'opacity-60' : ''} border-0 m-0 p-0 min-w-0`}>
          { props.node.nodeType === 'model' && <MaterialSlot node={props.node as ModelNode} /> }
          { props.node.nodeType === 'model' && <AnimationSlot node={props.node as ModelNode} /> }
          { props.node.nodeType === 'sprite' && <SpriteEditor node={props.node as SpriteNode} /> }
          { props.node.nodeType === 'animatedSprite' && <AnimatedSpriteEditor /> }
          { props.node.nodeType === 'light' && <LightEditor node={props.node as LightNode} /> }
          { props.node.nodeType === 'lightProbe' && <LightProbeEditor node={props.node as LightProbeNode} /> }
          { props.node.nodeType === 'skybox' && <SkyboxEditor node={props.node as SkyboxNode} /> }
          { props.node.nodeType === 'camera' && <CameraEditor node={props.node as CameraNode} /> }
          { props.node.nodeType === 'cameraRig' && <CameraRigEditor node={props.node as CameraRigNode} /> }
          { props.node.nodeType === 'volumetricClouds' && <VolumetricCloudsEditor node={props.node as VolumetricCloudsNode} /> }
          { props.node.nodeType === 'skyAtmosphere' && <SkyAtmosphereEditor node={props.node as SkyAtmosphereNode} /> }
        </fieldset>
    </>
  )
}
