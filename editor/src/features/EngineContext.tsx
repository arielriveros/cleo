import { createContext, useContext, useState, useRef, useEffect } from "react";
import { CleoEngine, Scene, Camera, LightNode, DirectionalLight, CameraNode, InputManager, Model, Geometry, Material, Node, ModelNode, Vec, TextureManager } from "cleo";
import { CameraGeometry, GridGeometry } from "../utils/EditorModels";
import EventEmitter from "events";

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

type CylinderShapeDescription = {
  type: 'cylinder';
  offset: number[];
  rotation: number[];

  radius: number;
  height: number;
  numSegments: number;
};

type PlaneShapeDescription = {
  type: 'plane';
  offset: number[];
  rotation: number[];
};

export type BodyDescription = {
  mass: number;
  linearDamping: number;
  angularDamping: number;
  linearConstraints: [number, number, number];
  angularConstraints: [number, number, number];
  shapes: ShapeDescription[];
}
export type ShapeDescription = BoxShapeDescription | SphereShapeDescription | CylinderShapeDescription | PlaneShapeDescription;

// Create a context to hold the engine and scene
const EngineContext = createContext<{
  instance: CleoEngine | null;
  editorScene: Scene;
  eventEmmiter: EventEmitter;
  selectedNode: string | null;
  selectedScript: string | null;
  scripts: Map<string, {
    start: string;
    update: string;
    spawn: string;
    collision: string;
  }>;
  bodies: Map<string, BodyDescription>;
  }>({
  instance: null,
  editorScene: new Scene(),
  eventEmmiter: new EventEmitter(),
  selectedNode: null,
  selectedScript: null,
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
  const bodiesRef = useRef(new Map<string, BodyDescription>());

  const setupInitialScene = () => {
    const editorCameraNode = new CameraNode('__editor__Camera', new Camera({ far: 10000 }));
    editorCameraNode.active = true;
    editorCameraNode.setPosition([4, 4, 4]).setRotation([30, -135, 0]);

    const geometry = GridGeometry(200);
    const editorGridNode = new ModelNode('__editor__Grid', new Model(
        new Geometry(geometry.positions, undefined, geometry.texCoords, undefined, undefined, geometry.indices, false),
        Material.Basic({color: [0.75, 0.75, 0.75]}, {wireframe: true}))
    );


    const xAxis = new ModelNode('__editor__Xaxis', new Model(
        new Geometry([[-200, 0, 0], [200, 0, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
        Material.Basic({color: [1, 0, 0]}, {wireframe: true}))
    );
    xAxis.setPosition([100, 0.001, 0]);



    const Yaxis = new ModelNode('__editor__Yaxis', new Model(
        new Geometry([[0, -200, 0], [0, 200, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
        Material.Basic({color: [0, 1, 0]}, {wireframe: true}))
    );
    Yaxis.setPosition([0, 100, 0.001]);

    const Zaxis = new ModelNode('__editor__Zaxis', new Model(
        new Geometry([[0, 0, -200], [0, 0, 200]], undefined, undefined, undefined, undefined, [0, 1], false),
        Material.Basic({color: [0, 0, 1]}, {wireframe: true}))
    );
    Zaxis.setPosition([0, 0.001, 100]);

    // Adding editor nodes to the scene
    editorSceneRef.current.addNodes(editorCameraNode, editorGridNode, xAxis, Yaxis, Zaxis);

    const lightNode = new LightNode('light', new DirectionalLight({}));
    lightNode.setRotation([45, 45, 0]);
    lightNode.castShadows = true;

    const cameraNode = new CameraNode('camera', new Camera({}));
    cameraNode.active = true;
    const cameraModel = new Model(new Geometry(
      CameraGeometry.positions, undefined, CameraGeometry.texCoords, 
      undefined, undefined, CameraGeometry.indices, false), Material.Basic({color: [0.2, 0.2, 0.75]}, { castShadow: false }));
    const debugCameraModel = new ModelNode('__debug__CameraModel', cameraModel);
    debugCameraModel.onUpdate = (node) => {
      // Ignore scaling
      Vec.mat4.scale(node.worldTransform, node.worldTransform, Vec.vec3.inverse(Vec.vec3.create(), Vec.mat4.getScaling(Vec.vec3.create(), node.worldTransform)));
    };
    cameraNode.addChild(debugCameraModel);
    cameraNode.setPosition([0, 2, -5]).setRotation([30, 0, 0]);

    const physicalBox = new ModelNode('physical box', new Model(Geometry.Cube(), Material.Default({diffuse: [1, 0, 1]})));
    physicalBox.setPosition([-1, 3, 0]).setRotation([45, 0, 45]);

    const box2 = new ModelNode('box', new Model(Geometry.Cube(), Material.Default({})));
    box2.setPosition([1, 0, 0]).setUniformScale(0.5);

    const plane = new ModelNode('plane', new Model(Geometry.Quad(), Material.Default({diffuse: [0, 0.45, 0.1], specular: [0.2, 0.2, 0.2]})));
    plane.setPosition([0, -1, 0]).setRotation([-90, 0, 0]).setScale([10, 10, 1]);

    // Example nodes
    editorSceneRef.current.addNodes(lightNode, cameraNode, physicalBox, box2, plane);

    // Example bodies
    bodiesRef.current.set(physicalBox.id, {
        mass: 1,
        linearDamping: 0.01,
        angularDamping: 0.01,
        linearConstraints: [1, 1, 1],
        angularConstraints: [1, 1, 1],
        shapes: [ { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] } ]
    });
    // add debug shape for the box body
    const debugNode = new Node(`__debug__body_${physicalBox.id}`);
    debugNode.onUpdate = (node) => {
        node.setPosition(physicalBox.position);
        node.setRotation(physicalBox.rotation);
    };
    const debugModel = new Model(Geometry.Cube(1, 1, 1, true), Material.Basic({color: [1, 0, 0]}, {wireframe: true}));
    const modelNode = new ModelNode(`__debug__shape_0`, debugModel)
    debugNode?.addChild(modelNode);
    editorSceneRef.current.addNode(debugNode);

    bodiesRef.current.set(plane.id, {
        mass: 0,
        linearDamping: 0, angularDamping: 0,
        linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1],
        shapes: [ { type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] } ]
    });

    // Example scripts
    scriptsRef.current.set(physicalBox.id, { start: '', update: '', spawn: '', collision: 'console.log(`${node.name} collided with ${other.name}`)'});
    scriptsRef.current.set(lightNode.id, { start: '', update: 'node.rotateY(-10 * delta)', spawn: '', collision: ''});
  };

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
      
      setupInitialScene();

      // Setting the editor scene and camera
      engine.setScene(editorSceneRef.current);
      editorSceneRef.current.start();

      setSelectedNode(editorSceneRef.current.root.id);
      
      engine.run();

  }, []);

  // Event handling
  useEffect(() => {
    eventEmmiter.current.on('changeDimension', (dimension: '2D' | '3D') => {
      if (!instanceRef.current) return;

      // change camera to 2D
      let cameraNode = instanceRef.current.scene.activeCamera;
      if (dimension === '2D') {
        cameraNode.camera.type = 'orthographic';
        cameraNode.camera.top = 4;
        cameraNode.camera.bottom = -4;
        cameraNode.camera.left = -4;
        cameraNode.camera.right = 4;
        cameraNode.setZ(10).setRotation([0, 180, 0]);
        cameraNode.onUpdate = (node, delta, time) => {
            let mouse = InputManager.instance.mouse;
            let movement = delta;
            if (mouse.buttons.Left) {
                node.addX(-mouse.velocity[0] * movement);
                node.addY(mouse.velocity[1] * movement);

                InputManager.instance.isKeyPressed('KeyW') && node.addY(movement * 10);
                InputManager.instance.isKeyPressed('KeyS') && node.addY(-movement * 10);
                InputManager.instance.isKeyPressed('KeyA') && node.addX(-movement * 10);
                InputManager.instance.isKeyPressed('KeyD') && node.addX(movement * 10);
            }
        };

        // Rotate Grid
        const grid = editorSceneRef.current.getNodesByName('__editor__Grid')[0];
        grid.setRotation([90, 0, 0]);
      }
      else {
        cameraNode.camera.type = 'perspective';
        cameraNode.onUpdate = (node, delta, time) => {
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
        };

        // Rotate Grid
        const grid = editorSceneRef.current.getNodesByName('__editor__Grid')[0];
        grid.setRotation([0, 0, 0]);
      }
    });

    eventEmmiter.current.on('setPlayState', (state: 'play' | 'pause' | 'stop') => {
      if (!instanceRef.current) return;
      if (state === 'play') {
        instanceRef.current.isPaused = false;
        setPlayState('playing');
      }
      else if (state === 'pause') {
        instanceRef.current.isPaused = true;
        setPlayState('paused');
      }
      else if (state === 'stop') {
        setPlayState('stopped');
        instanceRef.current.isPaused = false; // Unpause for editor scene
      }
    });

    eventEmmiter.current.on('selectNode', (node: string | null) => {
      setSelectedNode(node);
    });

    eventEmmiter.current.on('selectScript', (script: string | null) => {
      setSelectedScript(script);
    });

    // Default values
    eventEmmiter.current.emit('changeDimension', '3D');
    eventEmmiter.current.emit('setPlayState', 'stop');
    eventEmmiter.current.emit('selectScript', null);

    return () => {
      eventEmmiter.current.removeAllListeners();
    }
  }, [eventEmmiter]);

  return (
  <EngineContext.Provider value={{
      instance: instanceRef.current,
      editorScene: editorSceneRef.current,
      eventEmmiter: eventEmmiter.current,
      selectedNode, selectedScript,
      scripts: scriptsRef.current,
      bodies: bodiesRef.current
    }}>
    {props.children}
  </EngineContext.Provider>
  );
}