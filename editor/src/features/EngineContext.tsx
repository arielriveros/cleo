import { createContext, useContext, useState, useRef, useEffect } from "react";
import { CleoEngine, Scene, Camera, LightNode, DirectionalLight, CameraNode, InputManager, Model, Geometry, Material, ModelNode, Vec, TextureManager, Body } from "cleo";
import { CameraGeometry, GridGeometry } from "../utils/EditorModels";
import EventEmitter from "events";  // Import EventEmitter

type BoxShapeDescription = {
    type: 'box';
    offset: number[];
    rotation: number[];

    width: number;
    height: number;
    depth: number;
};

type SphereShapeDescription = {
    type: 'sphere';
    offset: number[];
    rotation: number[];

    radius: number;
};
type PlaneShapeDescription = {
    type: 'plane';
    offset: number[];
    rotation: number[];
};

export type ShapeDescription = BoxShapeDescription | SphereShapeDescription | PlaneShapeDescription;

// Create a context to hold the engine and scene
const EngineContext = createContext<{
    instance: CleoEngine | null;
    editorScene: Scene;
    eventEmmiter: EventEmitter;
    selectedNode: string | null;
    playState: 'playing' | 'paused' | 'stopped';
    setPlayState: (state: 'playing' | 'paused' | 'stopped') => void;
    setSelectedNode: (node: string | null) => void;
    selectedScript: string | null;
    setSelectedScript: (script: string | null) => void;
    scripts: Map<string, {
        start: string;
        update: string;
        spawn: string;
        collision: string;
    }>;
    bodies: Map<string, {
        mass: number;
        linearDamping: number;
        angularDamping: number;
        shapes: ShapeDescription[];
    }>;
  }>({
    instance: null,
    editorScene: new Scene(),
    eventEmmiter: new EventEmitter(),
    selectedNode: null,
    playState: 'stopped',
    setPlayState: () => {},
    setSelectedNode: () => {},
    selectedScript: null,
    setSelectedScript: () => {},
    scripts: new Map(),
    bodies: new Map(),
  });
  
  // Create a custom hook to access the engine and scene from anywhere
export const useCleoEngine = () => {
    return useContext(EngineContext);
};

export function EngineProvider(props: { children: React.ReactNode }) {
    const instanceRef = useRef<CleoEngine | null>(null);
    const editorSceneRef = useRef<Scene>(new Scene());
    const textureManagerRef = useRef<TextureManager | null>(null);
    const eventEmmiter = useRef(new EventEmitter());
    const [playState, setPlayState] = useState<'playing' | 'paused' | 'stopped'>('stopped');
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const [selectedScript, setSelectedScript] = useState<string | null>(null);
    const scriptsRef = useRef(new Map<string, { start: string, update: string, spawn: string, collision: string }>());
    const bodiesRef = useRef(new Map<string, { mass: number, linearDamping: number, angularDamping: number, shapes: ShapeDescription[] }>());

    useEffect(() => {
        const engine = new CleoEngine({
            graphics: {
                clearColor: [0.65, 0.65, 0.71, 1.0],
            },
        });

        instanceRef.current = engine;
        instanceRef.current.isPaused = false;
        

        textureManagerRef.current = TextureManager.Instance;
        editorSceneRef.current.onChange = () => { eventEmmiter.current.emit('sceneChanged') }; // Emit the "sceneChanged" event 
        
        const editorCameraNode = new CameraNode('__editor__Camera', new Camera({
            far: 10000
        }));
        editorCameraNode.active = true;
        editorCameraNode.setPosition([4, 4, 4]);
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
        editorSceneRef.current.addNode(editorCameraNode);

        const geometry = GridGeometry(200);
        const editorGridNode = new ModelNode('__editor__Grid', new Model(
            new Geometry(geometry.positions, undefined, geometry.texCoords, undefined, undefined, geometry.indices, false),
            Material.Basic({color: [0.75, 0.75, 0.75]}, {wireframe: true}))
        );
        editorSceneRef.current.addNode(editorGridNode);

        const xAxis = new ModelNode('__editor__Xaxis', new Model(
            new Geometry([[-200, 0, 0], [200, 0, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
            Material.Basic({color: [1, 0, 0]}, {wireframe: true}))
        );
        xAxis.setPosition([100, 0.001, 0]);
        editorSceneRef.current.addNode(xAxis);

        const Yaxis = new ModelNode('__editor__Yaxis', new Model(
            new Geometry([[0, -200, 0], [0, 200, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
            Material.Basic({color: [0, 1, 0]}, {wireframe: true}))
        );
        Yaxis.setPosition([0, 100, 0.001]);
        editorSceneRef.current.addNode(Yaxis);

        const Zaxis = new ModelNode('__editor__Zaxis', new Model(
            new Geometry([[0, 0, -200], [0, 0, 200]], undefined, undefined, undefined, undefined, [0, 1], false),
            Material.Basic({color: [0, 0, 1]}, {wireframe: true}))
        );
        Zaxis.setPosition([0, 0.001, 100]);
        editorSceneRef.current.addNode(Zaxis);

        const lightNode = new LightNode('light', new DirectionalLight({}));
        lightNode.setRotation([45, 45, 0]);
        lightNode.castShadows = true;
        editorSceneRef.current.addNode(lightNode);

        scriptsRef.current.set(lightNode.id, { start: '', update: 'node.rotateY(-10 * delta)', spawn: '', collision: ''});

        const cameraNode = new CameraNode('camera', new Camera({}));
        cameraNode.active = true;
        const cameraModel = new Model(new Geometry(
            CameraGeometry.positions, undefined, CameraGeometry.texCoords, 
            undefined, undefined, CameraGeometry.indices, false), Material.Basic({color: [0.2, 0.2, 0.75]}, { castShadow: false }));
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
        cameraNode.setPosition([0, 2, -5]).setRotation([30, 0, 0]);
        editorSceneRef.current.addNode(cameraNode);

        const box1 = new ModelNode('physical box', new Model(Geometry.Cube(), Material.Default({diffuse: [1, 0, 0]})));
        box1.setPosition([-1, 3, 0]).setRotation([45, 0, 45]);
        editorSceneRef.current.addNode(box1);

        bodiesRef.current.set(box1.id, {
            mass: 1,
            linearDamping: 0.01,
            angularDamping: 0.01,
            shapes: [ { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] } ]
        });

        scriptsRef.current.set(box1.id, { start: '', update: '', spawn: '', collision: 'console.log(`${node.name} collided with ${other.name}`)'});

        const box2 = new ModelNode('box', new Model(Geometry.Cube(), Material.Default({})));
        box2.setPosition([1, 0, 0]).setUniformScale(0.5);
        editorSceneRef.current.addNode(box2);

        const plane = new ModelNode('plane', new Model(Geometry.Quad(), Material.Default({diffuse: [0, 0.45, 0.1], specular: [0.2, 0.2, 0.2]})));
        plane.setPosition([0, -1, 0]).setRotation([-90, 0, 0]).setScale([10, 10, 1]);
        editorSceneRef.current.addNode(plane);

        bodiesRef.current.set(plane.id, {
            mass: 0, linearDamping: 0, angularDamping: 0,
            shapes: [ { type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] } ]
        });

        // Setting the editor scene and camera
        engine.setScene(editorSceneRef.current);
        editorSceneRef.current.start();
        
        engine.run();
    }, []);

    return (
    <EngineContext.Provider value={{
            instance: instanceRef.current,
            editorScene: editorSceneRef.current,
            playState, setPlayState,
            eventEmmiter: eventEmmiter.current,
            selectedNode, setSelectedNode,
            selectedScript, setSelectedScript,
            scripts: scriptsRef.current,
            bodies: bodiesRef.current
        }}>
        {props.children}
    </EngineContext.Provider>
    );
}