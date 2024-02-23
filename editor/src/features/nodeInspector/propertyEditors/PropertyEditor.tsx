import { Node, ModelNode, SkyboxNode, LightNode, CameraNode } from 'cleo'
import MaterialEditor from './MaterialEditor'
import SkyboxEditor from './SkyboxEditor'
import TransformEditor from './TransformEditor'
import LightEditor from './LightEditor'
import NodeInfo from './NodeInfo'
import CameraEditor from './CameraEditor'

export default function PropertyEditor(props: {node: Node}) {

  return (
    <>
        <NodeInfo node={props.node} />
        <TransformEditor node={props.node} />

        { props.node.nodeType === 'model' && <MaterialEditor node={props.node as ModelNode} /> }
        { props.node.nodeType === 'light' && <LightEditor node={props.node as LightNode} /> }
        { props.node.nodeType === 'skybox' && <SkyboxEditor node={props.node as SkyboxNode} /> }
        { props.node.nodeType === 'camera' && <CameraEditor node={props.node as CameraNode} /> }
    </>
  )
}
