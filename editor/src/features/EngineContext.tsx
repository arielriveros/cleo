import { CleoEngine, Scene, Camera, LightNode, DirectionalLight, Node } from "cleo";
import { createContext, useContext, useState, useRef, useEffect } from "react";

// Create a context to hold the engine and scene
const EngineContext = createContext<{
    instance: CleoEngine | null;
    scene: Scene | null;
    sceneChanged: boolean;
    selectedNode: string | null;
    setSelectedNode: (node: string | null) => void;
  }>({
    instance: null,
    scene: null,
    sceneChanged: false,
    selectedNode: null,
    setSelectedNode: () => {},
  });
  
  // Create a custom hook to access the engine and scene from anywhere
export const useCleoEngine = () => {
    return useContext(EngineContext);
};

export function EngineProvider(props: { children: React.ReactNode }) {
    const instanceRef = useRef<CleoEngine | null>(null);
    const [scene, setScene] = useState<Scene | null>(null);
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const [sceneChanged, setSceneChanged] = useState<boolean>(false);

    useEffect(() => {
        const engine = new CleoEngine({
            graphics: {
                clearColor: [0.65, 0.65, 0.71, 1.0],
            },
        });

        instanceRef.current = engine;

        const scene = new Scene();
        setScene(scene);

        scene.onChangeEvent = () => { setSceneChanged( (prev) => !prev ) };

        const camera = new Camera({
            position: [0, 0.5, -2],
        });

        const dirLight = new LightNode('dirLight', new DirectionalLight({}));
        dirLight.rotateX(45);
        dirLight.rotateY(30);
        scene.addNode(dirLight);

        engine.setScene(scene);
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
    <EngineContext.Provider value={{ instance: instanceRef.current, scene, sceneChanged, selectedNode, setSelectedNode }}>
        {props.children}
    </EngineContext.Provider>
    );
}