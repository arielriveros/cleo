import { createContext, useContext, useState, useRef, useEffect } from "react";
import { CleoEngine, Scene, Camera, LightNode, DirectionalLight, CameraNode, InputManager, Model, Geometry, Material, ModelNode } from "cleo";

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
    const [mode, setMode] = useState<'scene' | 'script'>('scene');
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
        scene.onChange = () => { setSceneChanged( (prev) => !prev ) };
        editorSceneRef.current = scene;
        
        const debugCameraNode = new CameraNode('__editor__Camera', new Camera());
        debugCameraNode.active = true;

        debugCameraNode.setPosition([0, 0.5, -2]);
        debugCameraNode.onUpdate = (node, delta, time) => {
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
        scene.addNode(debugCameraNode);

        const lightNode = new LightNode('light', new DirectionalLight({}));
        lightNode.setRotation([45, 45, 0]);
        scene.addNode(lightNode);

        const cameraNode = new CameraNode('camera', new Camera({}));
        cameraNode.active = true;
        const debugCameraModel = new ModelNode('__debug__CameraModel', new Model(Geometry.Cube(), Material.Basic({}, {wireframe: true})) )
        debugCameraModel.setUniformScale(0.2);
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