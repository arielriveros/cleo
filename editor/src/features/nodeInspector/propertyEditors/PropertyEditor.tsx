import { Node, ModelNode, SkyboxNode, LightNode, LightProbeNode, CameraNode, SpriteNode, VolumetricCloudsNode, SkyAtmosphereNode } from 'cleo'
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

export default function PropertyEditor(props: {node: Node, readOnly?: boolean}) {
  // Check if the node is the root node
  const isRootNode = props.node.id === 'root' || props.node.name === 'root';
  const ro = !!props.readOnly;

  return (
    <>
        {/* NodeInfo (name locked, Delete kept) and Transform stay editable for instances. */}
        <NodeInfo node={props.node} readOnly={ro} />
        {!isRootNode && <TransformEditor node={props.node} />}

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
          { props.node.nodeType === 'volumetricClouds' && <VolumetricCloudsEditor node={props.node as VolumetricCloudsNode} /> }
          { props.node.nodeType === 'skyAtmosphere' && <SkyAtmosphereEditor node={props.node as SkyAtmosphereNode} /> }
        </fieldset>
    </>
  )
}
