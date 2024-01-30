import { Geometry, Material, Model, Node, ModelNode, LightNode, DirectionalLight, PointLight } from 'cleo'
import Collapsable from '../../components/Collapsable';
import { useCleoEngine } from '../EngineContext';

export default function AddNew(props: {node: Node}) {

    const { instance } = useCleoEngine();

    const addNode = (newNode: Node) => {
        if (props.node?.name === 'root')
        instance?.scene?.addNode(newNode);
        else
        props.node?.addChild(newNode);
    }
    
    const addCube = () => {
        const cubeNode = new ModelNode('cube', new Model(Geometry.Cube(), Material.Default({})));
        addNode(cubeNode);
    };
    
    const addSphere = () => {
        const sphereNode = new ModelNode('sphere', new Model(Geometry.Sphere(), Material.Default({})));
        addNode(sphereNode);
    };
    
    const addPlane = () => {
        const planeNode = new ModelNode('plane', new Model(Geometry.Quad(), Material.Default({}, {side: 'double'})));
        addNode(planeNode);
    }

    return (
        <Collapsable title='Add'>
            <button onClick={() => addNode(new Node('node')) }>Empty Node</button>
            <div>Basic Shapes</div>
            <div>
                <button onClick={() => addCube() }>Cube</button>
                <button onClick={() => addSphere() }>Sphere</button>
                <button onClick={() => addPlane() }>Plane</button>
            </div>

            <div>Lights</div>
            <div>
                <button onClick={() => addNode(new LightNode('directional light', new DirectionalLight({}))) }>Directional Light</button>
                <button onClick={() => addNode(new LightNode('point light', new PointLight({}))) }>Point Light</button>
            </div>

        </Collapsable>
    )
}
