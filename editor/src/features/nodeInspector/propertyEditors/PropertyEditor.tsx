import { Node, ModelNode, SkyboxNode, LightNode, LightProbeNode, CameraNode, SpriteNode } from 'cleo'
import MaterialEditor from './MaterialEditor'
import SkyboxEditor from './SkyboxEditor'
import TransformEditor from './TransformEditor'
import LightEditor from './LightEditor'
import LightProbeEditor from './LightProbeEditor'
import NodeInfo from './NodeInfo'
import CameraEditor from './CameraEditor'
import SpriteEditor from './SpriteEditor'
import AnimatedSpriteEditor from './SpriteSheetEditor'
import CustomVariablesEditor from './CustomVariablesEditor'

export default function PropertyEditor(props: {node: Node}) {
  // Check if the node is the root node
  const isRootNode = props.node.id === 'root' || props.node.name === 'root';

  return (
    <>
        <NodeInfo node={props.node} />
        {!isRootNode && <TransformEditor node={props.node} />}

        { props.node.nodeType === 'model' && <MaterialEditor node={props.node as ModelNode} /> }
        { props.node.nodeType === 'sprite' && <SpriteEditor node={props.node as SpriteNode} /> }
        { props.node.nodeType === 'animatedSprite' && <AnimatedSpriteEditor /> }
        { props.node.nodeType === 'light' && <LightEditor node={props.node as LightNode} /> }
        { props.node.nodeType === 'lightProbe' && <LightProbeEditor node={props.node as LightProbeNode} /> }
        { props.node.nodeType === 'skybox' && <SkyboxEditor node={props.node as SkyboxNode} /> }
        { props.node.nodeType === 'camera' && <CameraEditor node={props.node as CameraNode} /> }

        {!isRootNode && <CustomVariablesEditor node={props.node} />}
    </>
  )
}
