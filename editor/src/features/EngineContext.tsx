import { createContext, useContext, useState, useRef, useEffect } from "react";
import { CleoEngine, Scene, Camera, LightNode, DirectionalLight, CameraNode, InputManager, Model, Geometry, Material, Node, ModelNode, Vec, TextureManager, SpriteNode, Sprite } from "cleo";
import { CameraGeometry, GridGeometry } from "../utils/EditorModels";
import NullImage from '../images/null.png';
import DinosaurImage from '../images/dinosaur.png';
import LightIcon from '../icons/light.png';
import EventEmitter from "events";
import { createDemoScene } from './demoScene/createDemoScene';

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
  eventEmitter: EventEmitter;
  selectedNode: string | null;
  isGizmoDragging: boolean;
  isPlayMode: boolean;
  scripts: Map<string, string>;
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[]; }>;
  }>({
    instance: null,
    editorScene: new Scene(),
    eventEmitter: new EventEmitter(),
    selectedNode: null,
    isGizmoDragging: false,
    isPlayMode: false,
    scripts: new Map(),
    bodies: new Map(),
    triggers: new Map()
  });
  
  // Create a custom hook to access the engine and scene from anywhere
export const useCleoEngine = () => {
    return useContext(EngineContext);
};

export function EngineProvider(props: { children: React.ReactNode }) {
  const instanceRef = useRef<CleoEngine | null>(null);
  const editorSceneRef = useRef<Scene>(new Scene());
  const eventEmitter = useRef(new EventEmitter());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [isGizmoDragging, setIsGizmoDragging] = useState(false);
  const [isPlayMode, setIsPlayMode] = useState(false);
  const isGizmoDraggingRef = useRef(false);
  const scriptsRef = useRef(new Map<string, string>());
  const bodiesRef = useRef(new Map<string, BodyDescription>());
  const triggersRef = useRef(new Map<string, { shapes: ShapeDescription[] }>());

  const setupInitialScene = async () => {
    await createDemoScene({
      scene: editorSceneRef.current,
      scripts: scriptsRef.current,
      bodies: bodiesRef.current,
      triggers: triggersRef.current,
    });
  };

  useEffect(() => {
      const initializeEngine = async () => {
          const engine = new CleoEngine({
              graphics: {
                  clearColor: [0.65, 0.65, 0.71, 1.0],
              },
          });

          instanceRef.current = engine;
          instanceRef.current.isPaused = false;

          CleoEngine.eventEmitter.on('LOG', (log) => { eventEmitter.current.emit('LOG', log) });
          CleoEngine.eventEmitter.on('SCENE_CHANGED', () => { eventEmitter.current.emit('SCENE_CHANGED') });
          
          await setupInitialScene();

          TextureManager.Instance.addTextureFromBase64(NullImage, {}, 'Null');
          TextureManager.Instance.addTextureFromBase64(DinosaurImage, {}, 'dinosaur.png');
          TextureManager.Instance.addTextureFromBase64(LightIcon, {
            mipMap: false
          }, '__editor__light_icon');
          eventEmitter.current.emit('TEXTURES_CHANGED');

          // Setting the editor scene and camera
          engine.setScene(editorSceneRef.current);
          editorSceneRef.current.start();

          setSelectedNode(editorSceneRef.current.root.id);
          
          engine.run();
      };

      initializeEngine();
  }, []);

  // Event handling
  useEffect(() => {
    eventEmitter.current.on('CHANGE_DIMENSION', (dimension: '2D' | '3D') => {
      if (!instanceRef.current) return;

      // Wait for scene to be ready
      if (!instanceRef.current.scene) {
        console.log('Scene not ready yet, retrying...');
        setTimeout(() => {
          eventEmitter.current.emit('CHANGE_DIMENSION', dimension);
        }, 100);
        return;
      }

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
            const mouse = InputManager.instance.mouse;
            const movement = delta;
            // Pan with left button when not dragging gizmo
            if (mouse.buttons.Left && !isGizmoDraggingRef.current) {
                node.addX(-mouse.velocity[0] * movement);
                node.addY(mouse.velocity[1] * movement);

                InputManager.instance.isKeyPressed('KeyW') && node.addY(movement * 10);
                InputManager.instance.isKeyPressed('KeyS') && node.addY(-movement * 10);
                InputManager.instance.isKeyPressed('KeyA') && node.addX(-movement * 10);
                InputManager.instance.isKeyPressed('KeyD') && node.addX(movement * 10);
            }
            // Zoom with mouse wheel by scaling ortho extents
            if (!isGizmoDraggingRef.current && Math.abs(mouse.wheel.deltaY) > 0) {
              const step = -mouse.wheel.deltaY * 0.001; // wheel up -> zoom in
              const factor = Math.max(0.1, 1 + step); // avoid inverting
              const cam = cameraNode.camera;
              cam.top *= factor;
              cam.bottom *= factor;
              cam.left *= factor;
              cam.right *= factor;
              // Clamp minimal extent to avoid zero frustum
              const minExtent = 0.1;
              if (Math.abs(cam.top) < minExtent) {
                const sign = cam.top >= 0 ? 1 : -1;
                cam.top = sign * minExtent;
              }
              if (Math.abs(cam.bottom) < minExtent) {
                const sign = cam.bottom >= 0 ? 1 : -1;
                cam.bottom = sign * minExtent;
              }
              if (Math.abs(cam.left) < minExtent) {
                const sign = cam.left >= 0 ? 1 : -1;
                cam.left = sign * minExtent;
              }
              if (Math.abs(cam.right) < minExtent) {
                const sign = cam.right >= 0 ? 1 : -1;
                cam.right = sign * minExtent;
              }
            }
        };

        // Rotate Grid
        const grid = editorSceneRef.current.getNodesByName('__editor__Grid')[0];
        grid.setRotation([90, 0, 0]);
      }
      else {
        cameraNode.camera.type = 'perspective';
        cameraNode.onUpdate = (node, delta, time) => {
          const mouse = InputManager.instance.mouse;
          const movement = delta * 2;
          // Rotate and move with left button when not dragging gizmo
          if (mouse.buttons.Left && !isGizmoDraggingRef.current) {
            node.rotateX( mouse.velocity[1] * movement * 5).rotateY(-mouse.velocity[0] * movement * 5);
            InputManager.instance.isKeyPressed('KeyW') && node.addForward(movement);
            InputManager.instance.isKeyPressed('KeyS') && node.addForward(-movement);
            InputManager.instance.isKeyPressed('KeyA') && node.addRight(-movement);
            InputManager.instance.isKeyPressed('KeyD') && node.addRight(movement);
            InputManager.instance.isKeyPressed('KeyE') && node.addY(movement);
            InputManager.instance.isKeyPressed('KeyQ') && node.addY(-movement);
          }
          // Zoom with mouse wheel by dollying the camera forward/backward
          if (!isGizmoDraggingRef.current && Math.abs(mouse.wheel.deltaY) > 0) {
            const zoom = -mouse.wheel.deltaY * 0.01; // wheel up -> move forward
            node.addForward(zoom);
          }
        };

        // Rotate Grid
        const grid = editorSceneRef.current.getNodesByName('__editor__Grid')[0];
        grid.setRotation([0, 0, 0]);
      }
    });

    eventEmitter.current.on('SET_PLAY_STATE', (state: 'play' | 'pause' | 'stop') => {
      if (!instanceRef.current) return;
      if (state === 'play') {
        instanceRef.current.isPaused = false;
        setIsPlayMode(true);
      }
      else if (state === 'pause') {
        instanceRef.current.isPaused = true;
        setIsPlayMode(true);
      }
      else if (state === 'stop') {
        instanceRef.current.isPaused = false; // Unpause for editor scene
        setIsPlayMode(false);
      }
    });

    eventEmitter.current.on('SELECT_NODE', (node: string | null) => {
      console.log('SELECT_NODE event received:', node);
      setSelectedNode(node);
      
      // Use stencil-based outlining instead of creating outline nodes
      if (instanceRef.current && instanceRef.current.renderer) {
        instanceRef.current.renderer.setSelectedNode(node);
        console.log('Selection updated in renderer:', node);
      }
    });

    eventEmitter.current.on('GIZMO_DRAG_START', (data: { axis: string, nodeId: string }) => {
      console.log('GIZMO_DRAG_START event received:', data);
      setIsGizmoDragging(true);
      isGizmoDraggingRef.current = true;
    });

    eventEmitter.current.on('GIZMO_DRAG_END', (data: { axis: string | null, nodeId: string | null }) => {
      console.log('GIZMO_DRAG_END event received:', data);
      setIsGizmoDragging(false);
      isGizmoDraggingRef.current = false;
    });

    // Reset gizmo dragging state
    isGizmoDraggingRef.current = false;
    setIsGizmoDragging(false);

    // Default values
    eventEmitter.current.emit('CHANGE_DIMENSION', '3D');
    eventEmitter.current.emit('SET_PLAY_STATE', 'stop');
    eventEmitter.current.emit('SELECT_SCRIPT', null);

    return () => {
      eventEmitter.current.removeAllListeners();
    }
  }, [eventEmitter]);

  return (
  <EngineContext.Provider value={{
      instance: instanceRef.current,
      editorScene: editorSceneRef.current,
      eventEmitter: eventEmitter.current,
      selectedNode,
      isGizmoDragging,
      isPlayMode,
      scripts: scriptsRef.current,
      bodies: bodiesRef.current,
      triggers: triggersRef.current
    }}>
    {props.children}
  </EngineContext.Provider>
  );
}