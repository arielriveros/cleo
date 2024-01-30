
import { useCleoEngine } from '../EngineContext'
import { useEffect, useState } from 'react'
import { Node } from 'cleo';
import Sidebar from '../../components/Sidebar'
import ModelIcon from '../../icons/model.png'
import LightIcon from '../../icons/light.png'
import './SceneInspector.css'

interface SceneNodeItemProps {
    nodeId: string;
    nodeName?: string;
    nodeType?: string;
    children?: string[];
    onSelect: (nodeId: string) => void;
    onExpand?: (nodeId: string) => void;
}
function SceneNodeItem(props: SceneNodeItemProps) {
    return (
        <span className='sceneItem' onClick={() => props.onSelect(props.nodeId)}>
            <div>
                {props.nodeType === 'model' && <img src={ModelIcon} alt='model' className='sceneItemIcon' /> }
                {props.nodeType === 'light' && <img src={LightIcon} alt='light' className='sceneItemIcon' /> }
                {props.nodeName}
            </div>
            {props.children && props.children.length > 0 && <div onClick={() => props.onExpand && props.onExpand(props.nodeId)}>+</div>}
        </span>
    )
}

function SceneListRecursive(props: { node: { id: string, name: string, type: string, children: any[]}, setSelectedNode: (nodeId: string) => void}) {
    const [isVisible, setIsVisible] = useState(true);
    const expand = () => {
      setIsVisible(!isVisible);
    };
    return (
        <div style={{ paddingLeft: 5 }}>
            <SceneNodeItem
                key={props.node.id}
                nodeId={props.node.id}
                nodeName={props.node.name}
                nodeType={props.node.type}
                onSelect={props.setSelectedNode}
                onExpand={expand}
                children={props.node.children}
                />
            { isVisible ? 
                props.node.children.map( child => { return <SceneListRecursive key={child.id} node={child} setSelectedNode={props.setSelectedNode}/> })
            : <></>
            }
      </div>    
    );
  }


export default function SceneInspector() {
    const { instance, sceneChanged, setSelectedNode } = useCleoEngine()
    const [ nodes, setNodes ] = useState<{ id: string, name: string, type: string, children: any[]} | null>(null);

    // generate a recursive list of id nodes where each node has a list of children
    // { id: 'root', children: [{ id: 'child1', children: [{ id: 'child3', children: [] }] }, { id: 'child2', children: [] }] }
    function generateNodeList(node: Node): { id: string, name: string, type: string, children: any[]} {
        return {
            id: node.id,
            name: node.name,
            type: node.nodeType,
            children: node.children.map((child: Node) => generateNodeList(child))
        }
    }

    useEffect(() => {
        if (instance?.scene)
            setNodes(generateNodeList(instance.scene.root));
    }, [sceneChanged])
    return (
        <Sidebar width='20vw'>
            <div className='sceneInspector'>{
                nodes && <SceneListRecursive node={nodes} setSelectedNode={setSelectedNode}/>
            }</div>
        </Sidebar>

    )
}
