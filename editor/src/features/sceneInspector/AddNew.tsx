import { Geometry, Material, Model, Node, ModelNode, LightNode, DirectionalLight, PointLight, SkyboxNode, Skybox } from 'cleo'
import Collapsable from '../../components/Collapsable';
import { useCleoEngine } from '../EngineContext';
import { useEffect, useState } from 'react';

export default function AddNew() {
    const [node, setNode] = useState<Node | null>(null)
    const { scene, selectedNode } = useCleoEngine();

    useEffect(() => {
        if (scene && selectedNode) {
            const node = scene.getNodeById(selectedNode)
            if (node) setNode(node)
        }
    }, [selectedNode])

    const addNode = (newNode: Node) => {
        if (node?.name === 'root')
        scene?.addNode(newNode);
        else
        node?.addChild(newNode);
    }
    
    const addCube = () => {
        const cubeNode = new ModelNode('cube', new Model(Geometry.Cube(), Material.Default({})));
        addNode(cubeNode);
    }
    
    const addSphere = () => {
        const sphereNode = new ModelNode('sphere', new Model(Geometry.Sphere(), Material.Default({})));
        addNode(sphereNode);
    }
    
    const addPlane = () => {
        const planeNode = new ModelNode('plane', new Model(Geometry.Quad(), Material.Default({}, {side: 'double'})));
        addNode(planeNode);
    }

    const addSkybox = () => {
        import ('../../images/null.png').then( (imgSrc) => {
            const img = new Image();
            img.src = imgSrc.default;
            img.onload = () => {
                const skyboxNode = new SkyboxNode('skybox', new Skybox({
                    posX: img,
                    negX: img,
                    posY: img,
                    negY: img,
                    posZ: img,
                    negZ: img,
                }));
                addNode(skyboxNode);
            }
            
        })
    }

    return (
        <Collapsable title='Add'>
            <button onClick={() => addNode(new Node('node')) }>Empty Node</button>
            <div>
                Basic Shapes
                <div>
                    <button onClick={() => addCube() }>Cube</button>
                    <button onClick={() => addSphere() }>Sphere</button>
                    <button onClick={() => addPlane() }>Plane</button>
                </div>
            </div>

            <div>
                Lights
                <div>
                    <button onClick={() => addNode(new LightNode('directional light', new DirectionalLight({}))) }>Directional Light</button>
                    <button onClick={() => addNode(new LightNode('point light', new PointLight({}))) }>Point Light</button>
                </div>
            </div>

            <div>
                Environment
                <div>
                    <button onClick={() => addSkybox() }>Skybox</button>
                </div>
            </div>


        </Collapsable>
    )
}
