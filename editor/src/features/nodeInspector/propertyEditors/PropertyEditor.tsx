import { Node, ModelNode, SkyboxNode, LightNode } from 'cleo'
import { ButtonWithConfirm } from '../../../components/Button'
import Collapsable from '../../../components/Collapsable'
import MaterialEditor from './MaterialEditor'
import SkyboxEditor from './SkyboxEditor'
import TransformEditor from './TransformEditor'
import LightEditor from './LightEditor'

export default function PropertyEditor(props: {node: Node}) {

  return (
    <>
        <Collapsable title='Node Information'>
        Name: {props.node.name}
        <br />
        Id: {props.node.id}
        <br />
        Type: { props.node.nodeType.charAt(0).toUpperCase() + props.node.nodeType.slice(1) }
        <br />
        Children: {props.node.children.length}
        <br />
        <ButtonWithConfirm onClick={() => props.node.remove()}>Delete</ButtonWithConfirm>
        </Collapsable>

        <TransformEditor node={props.node} />

        { props.node.nodeType === 'model' && <MaterialEditor node={props.node as ModelNode} /> }
        { props.node.nodeType === 'light' && <LightEditor node={props.node as LightNode} /> }
        { props.node.nodeType === 'skybox' && <SkyboxEditor node={props.node as SkyboxNode} /> }
    </>
  )
}
