import { Geometry, Material, Model, Node, ModelNode, LightNode, DirectionalLight, PointLight, SkyboxNode, Skybox, CameraNode, Camera, Vec } from 'cleo'
import Collapsable from '../../components/Collapsable';
import { useCleoEngine } from '../EngineContext';
import { useEffect, useState } from 'react';
import { CameraGeometry } from '../../utils/EditorModels';

export default function AddNew() {
    const [node, setNode] = useState<Node | null>(null)
    const { editorScene, selectedNode } = useCleoEngine();

    useEffect(() => {
        if (editorScene && selectedNode) {
            const node = editorScene.getNodeById(selectedNode)
            if (node) setNode(node)
        }
    }, [selectedNode])

    const addNode = (newNode: Node) => {
        node?.addChild(newNode);
    }

    const addCamera = () => { 
        const cameraNode = new CameraNode('camera', new Camera({}));
        cameraNode.active = true;
        const cameraModel = new Model(
            new Geometry( CameraGeometry.positions, undefined, CameraGeometry.texCoords, undefined, undefined, CameraGeometry.indices, false),
            Material.Basic({color: [0.2, 0.2, 0.75]})
        );
        const debugCameraModel = new ModelNode('__debug__CameraModel', cameraModel);
        debugCameraModel.onUpdate = (node) => {
            // Get the scale from the world matrix of the parent node
            if (!node.parent) return;
            const compensationScale = Vec.mat4.getScaling(Vec.vec3.create(), node.parent.worldTransform);

            // Inverse scale to get the compensation scale
            Vec.vec3.inverse(compensationScale, compensationScale);
        
            // Set the scale of the camera model with the compensation
            node.setScale(compensationScale);
        };
        cameraNode.addChild(debugCameraModel);
        
        addNode(cameraNode);
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

    const addPointLight = () => {
        const pointLightNode = new LightNode('point light', new PointLight({}));
        const debugPointLightModel = new ModelNode('__debug__LightModel', new Model(Geometry.Sphere(8), Material.Basic({}, {wireframe: true})) )
        debugPointLightModel.setUniformScale(0.2);
        pointLightNode.addChild(debugPointLightModel);
        addNode(pointLightNode);
    }

    return (
        <Collapsable title='Add'>
            <button onClick={() => addNode(new Node('node')) }>Empty Node</button>
            <div>
                Cameras
                <div>
                    <button onClick={() => addCamera() }>Camera</button>
                </div>
            </div>
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
                    <button onClick={() => addPointLight() }>Point Light</button>
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
