import { createContext, useContext, useState, useRef, useEffect } from "react";
import { CleoEngine, Scene, Camera, LightNode, DirectionalLight } from "cleo";

// Create a context to hold the engine and scene
const EngineContext = createContext<{
    instance: CleoEngine | null;
    editorScene: Scene | null;
    sceneChanged: boolean;
    selectedNode: string | null;
    setSelectedNode: (node: string | null) => void;
    mode: 'scene' | 'script';
    setMode: (mode: 'scene' | 'script') => void;
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
    mode: 'scene',
    setMode: () => {},
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
        editorSceneRef.current = scene;

        scene.onChange = () => { setSceneChanged( (prev) => !prev ) };

        // Setting a simple scene
        const dirLight = new LightNode('dirLight', new DirectionalLight({}));

        dirLight.rotateX(45);
        dirLight.rotateY(30);
        scene.addNode(dirLight);

        // Setting the editor scene and camera
        engine.setScene(scene);

        const camera = new Camera({
            position: [0, 0.5, -2],
        });
        engine.setCamera(camera);
        
        engine.onUpdate = (deltaTime) => {
            const speed = 2 * deltaTime;
            let mouse = engine.input.mouse;
            if (mouse.buttons.Left) {
                engine.camera.rotation[0] -= mouse.velocity[1] * speed / 10;
                engine.camera.rotation[1] -= mouse.velocity[0] * speed / 10;
            }
            engine.input.isKeyPressed('KeyW') && camera.moveForward(speed);
            engine.input.isKeyPressed('KeyS') && camera.moveForward(-speed);
            engine.input.isKeyPressed('KeyA') && camera.moveRight(-speed);
            engine.input.isKeyPressed('KeyD') && camera.moveRight(speed);
            engine.input.isKeyPressed('KeyE') && camera.moveUp(speed);
            engine.input.isKeyPressed('KeyQ') && camera.moveUp(-speed);
        }

        engine.run();
    }, []);

    return (
    <EngineContext.Provider value={{
            instance: instanceRef.current,
            editorScene: editorSceneRef.current, sceneChanged,
            selectedNode, setSelectedNode,
            mode, setMode,
            selectedScript, setSelectedScript,
            scripts: scriptsRef.current
        }}>
        {props.children}
    </EngineContext.Provider>
    );
}