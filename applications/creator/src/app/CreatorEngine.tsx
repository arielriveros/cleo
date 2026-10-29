import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CameraNode, Camera, CleoEngine, DirectionalLight, InputSystem, LIGHT_UNIT, LightNode, Scene } from 'cleo';
import { EngineHostProvider, type EngineHost } from '@cleo/app-kit/engine/EngineHost';
import { EDITOR_CAMERA_MAP } from '@cleo/app-kit/engine/viewCameraMap';
import { DEFAULT_VIEW_CAMERA_PREFS, stepViewCamera3D } from '@cleo/app-kit/engine/viewCamera';
import { readBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { EventEmitter } from '@cleo/app-kit/utils/eventEmitter';

// Cleo Creator hosts one CleoEngine, exactly as the Editor does, so a preview looks the way the asset
// will in a game: the same renderer, the same lighting model, the same terrain. The difference is that
// there is no project and no scene to save -- just a preview stage each tool dresses with its output.

export interface CreatorEngineState {
  instance: CleoEngine | null;
  /** The preview stage: a navigable camera and a sun. Tools add and remove their own nodes. */
  scene: Scene | null;
  camera: CameraNode | null;
  error: string | null;
  /** Whether the device can run compute (WebGPU): the GPU erosion and fluid paths need it. */
  hasCompute: boolean;
  bus: EventEmitter;
}

const CreatorEngineContext = createContext<CreatorEngineState | null>(null);

export function useCreatorEngine(): CreatorEngineState {
  const ctx = useContext(CreatorEngineContext);
  if (!ctx) throw new Error('useCreatorEngine outside CreatorEngineProvider');
  return ctx;
}

const CLEAR_COLOR = [0.11, 0.12, 0.16, 1];

function buildStage(): { scene: Scene; camera: CameraNode } {
  const scene = new Scene();
  // Named like the Editor's own camera so the engine treats it as tooling, never as content.
  const camera = new CameraNode('__editor__Camera', new Camera({ near: 1, far: 40000 }));
  camera.active = true;
  camera.setPosition([0, 260, 420]).setRotation([28, 180, 0]);
  camera.onUpdate = (dt) => stepViewCamera3D(camera, dt, { ...DEFAULT_VIEW_CAMERA_PREFS, flySpeed: 60 });
  scene.addNode(camera);
  scene.setActiveCamera(camera);
  const sun = new LightNode('sun', new DirectionalLight({ unit: LIGHT_UNIT }));
  sun.setRotation([55, 35, 0]);
  sun.castShadows = true;
  scene.addNode(sun);
  return { scene, camera };
}

function parkingViewport(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;overflow:hidden';
  document.body.appendChild(el);
  return el;
}

export function CreatorEngineProvider({ children }: { children: ReactNode }) {
  const bus = useRef(new EventEmitter()).current;
  const [state, setState] = useState<Omit<CreatorEngineState, 'bus'>>({
    instance: null, scene: null, camera: null, error: null, hasCompute: false,
  });

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const engine = new CleoEngine({ graphics: { clearColor: CLEAR_COLOR, backend: readBackendPreference() } });
        await engine.initialize();
        if (disposed) return;
        const { scene, camera } = buildStage();
        engine.setScene(scene);
        // Unpaused, so the scene updates every frame: camera navigation and transform edits need it.
        engine.isPaused = false;
        scene.animationsEnabled = false;
        scene.soundsEnabled = false;
        scene.start();
        InputSystem.instance.setOverlayMaps([EDITOR_CAMERA_MAP]);
        // The loop needs a sized viewport from its first frame; until a tool mounts its ViewportHost
        // (which re-parents the canvas), it renders into a 1px parking spot.
        engine.setViewport(parkingViewport());
        engine.renderer.resize();
        engine.run();
        if (import.meta.env.DEV) (window as unknown as { cleoCreator: unknown }).cleoCreator = { engine, scene, camera };
        engine.renderer.setGridVisible(true);
        engine.renderer.setGridPlane('xz');
        // The device handle is set during initialize(); read it lazily so this file stays importable
        // in environments without a GPU.
        const { device } = await import('cleo/graphics/rhi/deviceHandle');
        setState({ instance: engine, scene, camera, error: null, hasCompute: !!device?.capabilities?.hasCompute });
      } catch (e) {
        setState(s => ({ ...s, error: String((e as Error)?.message ?? e) }));
      }
    })();
    return () => { disposed = true; };
  }, []);

  const host = useMemo<EngineHost>(() => ({ instance: state.instance, isPlayMode: false, eventEmitter: bus }), [state.instance, bus]);
  const value = useMemo<CreatorEngineState>(() => ({ ...state, bus }), [state, bus]);

  return (
    <CreatorEngineContext.Provider value={value}>
      <EngineHostProvider value={host}>{children}</EngineHostProvider>
    </CreatorEngineContext.Provider>
  );
}
