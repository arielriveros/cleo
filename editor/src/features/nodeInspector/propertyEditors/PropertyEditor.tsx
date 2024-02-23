import { Node, ModelNode, SkyboxNode, LightNode } from 'cleo'
import { ButtonWithConfirm } from '../../../components/Button'
import Collapsable from '../../../components/Collapsable'
import MaterialEditor from './MaterialEditor'
import SkyboxEditor from './SkyboxEditor'
import TransformEditor from './TransformEditor'
import LightEditor from './LightEditor'
import NodeInfo from './NodeInfo'

export default function PropertyEditor(props: {node: Node}) {

  return (
    <>
        <NodeInfo node={props.node} />
        <TransformEditor node={props.node} />

        { props.node.nodeType === 'model' && <MaterialEditor node={props.node as ModelNode} /> }
        { props.node.nodeType === 'light' && <LightEditor node={props.node as LightNode} /> }
        { props.node.nodeType === 'skybox' && <SkyboxEditor node={props.node as SkyboxNode} /> }
    </>
  )
}
