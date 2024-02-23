import { createContext, useContext, useState, useRef, useEffect } from "react";
import { CleoEngine, Scene, Camera, LightNode, DirectionalLight, CameraNode, InputManager, Model, Geometry, Material, ModelNode, Vec } from "cleo";
import { CameraGeometry, GridGeometry } from "../utils/EditorModels";

// Create a context to hold the engine and scene
const EngineContext = createContext<{
    instance: CleoEngine | null;
    editorScene: Scene | null;
    sceneChanged: boolean;
    selectedNode: string | null;
    setSelectedNode: (node: string | null) => void;
    selectedScript: string | null;
    setSelectedScript: (script: string | null) => void;
    scripts: Map<string, {
        start: string;
        update: string;
        spawn: string;
    }>;
  }>({
    instance: null,
    editorScene: null,
    sceneChanged: false,
    selectedNode: null,
    setSelectedNode: () => {},
    selectedScript: null,
    setSelectedScript: () => {},
    scripts: new Map(),
  });
  
  // Create a custom hook to access the engine and scene from anywhere
export const useCleoEngine = () => {
    return useContext(EngineContext);
};

export function EngineProvider(props: { children: React.ReactNode }) {
    const instanceRef = useRef<CleoEngine | null>(null);
    const editorSceneRef = useRef<Scene | null>(null);
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const [sceneChanged, setSceneChanged] = useState<boolean>(false);
    const [selectedScript, setSelectedScript] = useState<string | null>(null);
    const scriptsRef = useRef(new Map<string, {start: string; update: string; spawn: string;}>());

    useEffect(() => {
        const engine = new CleoEngine({
            graphics: {
                clearColor: [0.65, 0.65, 0.71, 1.0],
            },
        });

        instanceRef.current = engine;
        instanceRef.current.isPaused = false;

        const scene = new Scene();
        scene.onChange = () => { setSceneChanged(prev => !prev ) };
        editorSceneRef.current = scene;
        
        const editorCameraNode = new CameraNode('__editor__Camera', new Camera({
            far: 10000
        }));
        editorCameraNode.active = true;
        editorCameraNode.setPosition([2, 2, 2]);
        editorCameraNode.setRotation([30, -135, 0]);
        editorCameraNode.onUpdate = (node, delta, time) => {
            let mouse = InputManager.instance.mouse;
            let movement = delta * 2;
            if (mouse.buttons.Left) {
                node.rotateX( mouse.velocity[1] * movement * 5).rotateY(-mouse.velocity[0] * movement * 5);
                InputManager.instance.isKeyPressed('KeyW') && node.addForward(movement);
                InputManager.instance.isKeyPressed('KeyS') && node.addForward(-movement);
                InputManager.instance.isKeyPressed('KeyA') && node.addRight(-movement);
                InputManager.instance.isKeyPressed('KeyD') && node.addRight(movement);
                InputManager.instance.isKeyPressed('KeyE') && node.addY(movement);
                InputManager.instance.isKeyPressed('KeyQ') && node.addY(-movement);
            }
        }
        scene.addNode(editorCameraNode);

        const geometry = GridGeometry(200);
        const editorGridNode = new ModelNode('__editor__Grid', new Model(
            new Geometry(geometry.positions, undefined, geometry.texCoords, undefined, undefined, geometry.indices, false),
            Material.Basic({color: [0.75, 0.75, 0.75]}, {wireframe: true}))
        );
        scene.addNode(editorGridNode);

        const xAxis = new ModelNode('__editor__Xaxis', new Model(
            new Geometry([[-200, 0, 0], [200, 0, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
            Material.Basic({color: [1, 0, 0]}, {wireframe: true}))
        );
        xAxis.setPosition([100, 0.001, 0]);
        scene.addNode(xAxis);

        const Yaxis = new ModelNode('__editor__Yaxis', new Model(
            new Geometry([[0, -200, 0], [0, 200, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
            Material.Basic({color: [0, 1, 0]}, {wireframe: true}))
        );
        Yaxis.setPosition([0, 100, 0.001]);
        scene.addNode(Yaxis);

        const Zaxis = new ModelNode('__editor__Zaxis', new Model(
            new Geometry([[0, 0, -200], [0, 0, 200]], undefined, undefined, undefined, undefined, [0, 1], false),
            Material.Basic({color: [0, 0, 1]}, {wireframe: true}))
        );
        Zaxis.setPosition([0, 0.001, 100]);
        scene.addNode(Zaxis);


        const lightNode = new LightNode('light', new DirectionalLight({}));
        lightNode.setRotation([45, 45, 0]);
        scene.addNode(lightNode);

        const cameraNode = new CameraNode('camera', new Camera({}));
        cameraNode.active = true;
        const cameraModel = new Model(new Geometry(
            CameraGeometry.positions, undefined, CameraGeometry.texCoords, 
            undefined, undefined, CameraGeometry.indices, false), Material.Basic({color: [0.2, 0.2, 0.75]}));
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
        cameraNode.setPosition([0, 0, -2]);
        scene.addNode(cameraNode);

        const box1 = new ModelNode('box', new Model(Geometry.Cube(), Material.Default({diffuse: [1, 0, 0]})));
        box1.setPosition([1, 0, 0]);
        scene.addNode(box1);

        const box2 = new ModelNode('box', new Model(Geometry.Cube(), Material.Default({})));
        box2.setPosition([-1, 0, 0]);
        box2.setUniformScale(0.5);
        scene.addNode(box2);

        // Setting the editor scene and camera
        engine.setScene(scene);
        scene.start();
        
        engine.onUpdate = (deltaTime) => {
            /* const camera = scene.getNodesByName('__editor__Camera')[0];
            const box2 = scene.getNodesByName('box')[1];
            if (camera && box2) {
                const forward = camera.forward;
                box2.setPosition([forward[0], forward[1], forward[2]]);

            } */
        }
        
        engine.run();
    }, []);

    return (
    <EngineContext.Provider value={{
            instance: instanceRef.current,
            editorScene: editorSceneRef.current, sceneChanged,
            selectedNode, setSelectedNode,
            selectedScript, setSelectedScript,
            scripts: scriptsRef.current
        }}>
        {props.children}
    </EngineContext.Provider>
    );
}