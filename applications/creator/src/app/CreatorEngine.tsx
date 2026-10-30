import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CameraNode, Camera, CleoEngine, DirectionalLight, InputSystem, LIGHT_UNIT, LightNode, Scene } from 'cleo';
import { EngineHostProvider, type EngineHost } from '@cleo/app-kit/engine/EngineHost';
import { EDITOR_CAMERA_MAP } from '@cleo/app-kit/engine/viewCameraMap';
import { DEFAULT_VIEW_CAMERA_PREFS, stepViewCamera3D } from '@cleo/app-kit/engine/viewCamera';
import { readBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { EventEmitter } from '@cleo/app-kit/utils/eventEmitter';
import { abandonBoot, bootLoad, finishIfSettled } from './bootLoad';

// Cleo Creator hosts one CleoEngine, exactly as the Editor does, so a preview looks the way the asset
// will in a game: the same renderer, the same lighting model, the same terrain. The difference is that
// there is no project and no scene to save -- just a preview stage each tool dresses with its output.

export interface CreatorEngineState {
  instance: CleoEngine | null;
  /** The preview stage: a navigable camera and a sun. Tools add and remove their own nodes. */
  scene: Scene | null;
  camera: CameraNode | null;
  /** The stage's directional light; a tool may aim it (FX Creator ties it to its light parameters). */
  sun: LightNode | null;
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

function buildStage(): { scene: Scene; camera: CameraNode; sun: LightNode } {
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
  return { scene, camera, sun };
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
    instance: null, scene: null, camera: null, sun: null, error: null, hasCompute: false,
  });

  useEffect(() => {
    let disposed = false;
    const boot = bootLoad();
    (async () => {
      try {
        const engine = new CleoEngine({ graphics: { clearColor: CLEAR_COLOR, backend: readBackendPreference() } });
        // With a progress callback the engine compiles its shaders in slices, so the loading screen
        // keeps painting through the longest part of startup.
        await engine.initialize({ onProgress: (phase, done, total) => {
          const step = boot.step(phase);
          if (done < total) { if (phase === 'shaders') step.progress(done, total); else step.start(); }
          else step.done(phase === 'device' ? engine.renderer.backend ?? '' : undefined);
        } });
        if (disposed) return;
        const { scene, camera, sun } = buildStage();
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
        setState({ instance: engine, scene, camera, sun, error: null, hasCompute: !!device?.capabilities?.hasCompute });
        // The first frame: two rAFs after run(), so one has actually been drawn.
        boot.step('frame').start();
        requestAnimationFrame(() => requestAnimationFrame(() => { boot.step('frame').done(); finishIfSettled(boot); }));
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        abandonBoot('not reached');
        setState(s => ({ ...s, error: message }));
      }
    })();
    return () => { disposed = true; };
  }, []);

  // A gizmo drag owns the mouse: the camera's input map goes off from GIZMO_DRAG_START to GIZMO_DRAG_END,
  // exactly as the editor does (EngineContext), so dragging a handle never also orbits the view.
  useEffect(() => {
    const off = () => InputSystem.instance.disableMap('EditorCamera');
    const on = () => InputSystem.instance.enableMap('EditorCamera');
    bus.on('GIZMO_DRAG_START', off);
    bus.on('GIZMO_DRAG_END', on);
    return () => { bus.off('GIZMO_DRAG_START', off); bus.off('GIZMO_DRAG_END', on); on(); };
  }, [bus]);

  const host = useMemo<EngineHost>(() => ({ instance: state.instance, isPlayMode: false, eventEmitter: bus }), [state.instance, bus]);
  const value = useMemo<CreatorEngineState>(() => ({ ...state, bus }), [state, bus]);

  return (
    <CreatorEngineContext.Provider value={value}>
      <EngineHostProvider value={host}>{children}</EngineHostProvider>
    </CreatorEngineContext.Provider>
  );
}
