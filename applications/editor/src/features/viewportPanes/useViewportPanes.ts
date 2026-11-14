// The split viewport: one editing pane and up to three preview panes over the same scene (the renderer's
// `setViewLayout`, render/viewLayout.ts). The editing pane is whichever the user last pointed at; its
// camera is pinned as `scene.activeCamera`, so every existing tool — picking, gizmos, drag-drop, camera
// navigation — keeps working through it unchanged, measuring against `CleoEngine.viewRect()` (the pane on
// screen) instead of the whole viewport. The preview panes redraw when something changes, or every frame
// when set to Realtime.
//
// Kept in step by a per-frame loop rather than effects: the scene's camera pin is reset by things this
// module never hears about (a scene parse re-pins the main camera, Simulate carries it away and back), and
// re-asserting the pin each frame is both cheaper and more robust than chasing every one of them.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraNode, CleoEngine, Scene } from 'cleo';
import { stepViewCamera3D, stepViewCameraOrtho } from '@cleo/app-kit/engine/viewCamera';
import { viewCameraPrefs } from '../EngineContext';
import {
  MAX_PANES, layoutGrid, loadPaneState, paneCount, savePaneState,
  type PaneLayout, type PanePose, type PanePreset, type PaneState,
} from './paneState';
import {
  applyPose, applyPreset, createPaneCamera, findCamera, isOrthoPreset, isPaneCamera, mainCamera, orthoHalf,
  paneCameraName, poseOf, viewCentre, DEFAULT_ORTHO_HALF,
} from './paneCameras';
import { paneView, setPaneView, type PaneBox } from './paneView';

/** How often the pane cameras' poses are written back to storage, at most. */
const POSE_SAVE_MS = 1000;

export interface ViewportPanes {
  /** The saved layout, focus and per-pane settings (poses aside). */
  state: PaneState;
  setLayout(layout: PaneLayout): void;
  setPreset(index: number, preset: PanePreset): void;
  setRealtime(index: number, realtime: boolean): void;
  /** Make the pane under a client point the editing pane (a drop lands where it is aimed). */
  focusPaneAt(clientX: number, clientY: number): void;
}

interface Options {
  instance: CleoEngine | null;
  viewportRef: React.RefObject<HTMLDivElement>;
  /** The open scene: the one the pane cameras live in, and only while it is the scene on screen. */
  mainScene: Scene | null;
  /** The open scene's id, which pane camera poses are stored under. */
  sceneKey: string;
  /** Whether splitting is allowed right now (`panesAllowed`). */
  allowed: boolean;
  eventEmitter: { on(event: string, fn: (...args: any[]) => void): void; off(event: string, fn: (...args: any[]) => void): void };
}

export function useViewportPanes({ instance, viewportRef, mainScene, sceneKey, allowed, eventEmitter }: Options): ViewportPanes {
  const [state, setState] = useState<PaneState>(() => loadPaneState());
  const stateRef = useRef(state);
  const instanceRef = useRef(instance);
  const allowedRef = useRef(allowed);
  const mainSceneRef = useRef(mainScene);
  const sceneKeyRef = useRef(sceneKey);
  instanceRef.current = instance;
  allowedRef.current = allowed;
  mainSceneRef.current = mainScene;
  sceneKeyRef.current = sceneKey;

  // Per pane camera: the preset it was last pointed with, and the scene key its pose belongs to.
  const presetOf = useRef(new WeakMap<CameraNode, PanePreset>());
  const keyOf = useRef(new WeakMap<CameraNode, string>());
  const navInstalled = useRef(new WeakSet<CameraNode>());
  const appliedKey = useRef('');
  const lastPoseSave = useRef(0);

  const commit = useCallback((next: PaneState, persist = true) => {
    stateRef.current = next;
    setState(next);
    if (persist) savePaneState(next);
  }, []);

  /** Store where each pane camera of `scene` is now, under the scene it was framed in. */
  const capturePoses = useCallback((scene: Scene, write: boolean) => {
    let changed = false;
    const poses = { ...stateRef.current.poses };
    for (let i = 1; i < MAX_PANES; i++) {
      const node = findCamera(scene, paneCameraName(i));
      const key = node ? keyOf.current.get(node) : undefined;
      if (!node || !key) continue;
      const list = poses[key] ? [...poses[key]] : Array.from({ length: MAX_PANES }, () => null as PanePose | null);
      const pose = poseOf(node);
      if (JSON.stringify(list[i]) === JSON.stringify(pose)) continue;
      list[i] = pose;
      poses[key] = list;
      changed = true;
    }
    if (!changed) return;
    stateRef.current = { ...stateRef.current, poses };
    if (write) savePaneState(stateRef.current);
  }, []);

  /** The pane camera `index` of `scene`, made and framed if it is not there (a fresh scene, a re-parse). */
  const ensurePaneCamera = (scene: Scene, index: number, main: CameraNode): CameraNode => {
    const preset = stateRef.current.panes[index].preset;
    let node = findCamera(scene, paneCameraName(index));
    if (!node) {
      node = createPaneCamera(index);
      scene.addNode(node);
      const pose = stateRef.current.poses[sceneKeyRef.current]?.[index];
      if (pose) applyPose(node, preset, pose);
      else applyPreset(node, preset, viewCentre(main));
      presetOf.current.set(node, preset);
      keyOf.current.set(node, sceneKeyRef.current);
    }
    if (presetOf.current.get(node) !== preset) {
      // A new preset frames what the pane was looking at, at the zoom it had when both are orthographic.
      const half = node.camera.type === 'orthographic' ? orthoHalf(node.camera) : DEFAULT_ORTHO_HALF;
      applyPreset(node, preset, viewCentre(node), half);
      presetOf.current.set(node, preset);
    }
    if (!navInstalled.current.has(node)) {
      const camera = node;
      // Navigation only while this is the camera being viewed through: the editing pane's.
      camera.onUpdate = (delta: number) => {
        const inst = instanceRef.current;
        if (!inst || inst.scene?.activeCamera !== camera) return;
        if (isOrthoPreset(presetOf.current.get(camera) ?? 'perspective'))
          stepViewCameraOrtho(camera, delta, viewCameraPrefs(), inst.renderer.editingPaneRect?.h ?? inst.renderer.canvas.height);
        else stepViewCamera3D(camera, delta, viewCameraPrefs());
      };
      navInstalled.current.add(node);
    }
    return node;
  };

  /** Take the pane cameras out of `scene` (the layout went back to one view), keeping their poses. */
  const removePaneCameras = (scene: Scene) => {
    capturePoses(scene, true);
    for (let i = 1; i < MAX_PANES; i++) {
      const node = findCamera(scene, paneCameraName(i));
      if (node) node.parent?.removeChild(node);
    }
  };

  /** One frame: the pin, the renderer's layout and the published pane boxes, brought into line. */
  const sync = useCallback(() => {
    const inst = instanceRef.current;
    const scene = inst?.scene;
    const renderer = inst?.renderer;
    if (!inst || !scene || !renderer) return;
    const st = stateRef.current;
    const main = mainSceneRef.current;
    const active = allowedRef.current && st.layout !== 'single' && !!main && scene === main;

    if (!active) {
      if (appliedKey.current) {
        renderer.setViewLayout(null);
        appliedKey.current = '';
      }
      // Hand the view back to the main camera if a pane camera still holds it.
      if (isPaneCamera(scene.activeCamera)) {
        const camera = mainCamera(scene);
        if (camera) scene.setActiveCamera(camera);
      }
      if (st.layout === 'single' && main && allowedRef.current) removePaneCameras(main);
      setPaneView({ active: false, layout: st.layout, focused: st.focused, boxes: [] });
      return;
    }

    const camera0 = mainCamera(scene);
    if (!camera0) return;
    const count = paneCount(st.layout);
    const cams: CameraNode[] = [camera0];
    for (let i = 1; i < count; i++) {
      const node = ensurePaneCamera(scene, i, camera0);
      // A camera framed under another scene's key (the open scene changed under it) is re-framed.
      if (keyOf.current.get(node) !== sceneKeyRef.current) {
        node.parent?.removeChild(node);
        cams.push(ensurePaneCamera(scene, i, camera0));
      } else cams.push(node);
    }
    const focused = Math.min(st.focused, count - 1);
    if (scene.activeCamera !== cams[focused]) scene.setActiveCamera(cams[focused]);

    const { cols, rows } = layoutGrid(st.layout);
    const key = `${cols}x${rows}|${focused}|${cams.map(c => c.id).join(',')}|${st.panes.slice(0, count).map(p => (p.realtime ? 1 : 0)).join('')}`;
    if (key !== appliedKey.current) {
      renderer.setViewLayout({
        cols, rows, primary: focused,
        panes: cams.map((camera, i) => ({ camera, realtime: st.panes[i].realtime })),
      });
      appliedKey.current = key;
    }

    // The panes in viewport CSS pixels, for the frames and headers drawn over them. Canvas pixels are CSS
    // pixels as the renderer sizes the canvas; scaled anyway in case a style stretches it.
    const canvas = renderer.canvas;
    const sx = canvas.width > 0 ? canvas.clientWidth / canvas.width : 1;
    const sy = canvas.height > 0 ? canvas.clientHeight / canvas.height : 1;
    const boxes: PaneBox[] = [];
    for (let i = 0; i < count; i++) {
      const r = renderer.paneRect(i);
      if (r) boxes.push({ left: r.x * sx, top: r.y * sy, width: r.w * sx, height: r.h * sy });
    }
    setPaneView({ active: true, layout: st.layout, focused, boxes });

    const now = performance.now(); // wall-clock: throttles a storage write, not the render
    if (now - lastPoseSave.current > POSE_SAVE_MS) {
      lastPoseSave.current = now;
      capturePoses(scene, true);
    }
  }, [capturePoses]);

  const focusPane = useCallback((index: number) => {
    const st = stateRef.current;
    if (index === st.focused || index < 0 || index >= paneCount(st.layout)) return;
    commit({ ...st, focused: index });
    // Now, not next frame: the very event that focused the pane goes on to pick, drag or zoom through it.
    sync();
  }, [commit, sync]);

  const paneAt = (clientX: number, clientY: number): number => {
    const el = viewportRef.current;
    const view = paneView();
    if (!el || !view.active) return -1;
    const box = el.getBoundingClientRect();
    const x = clientX - box.left, y = clientY - box.top;
    return view.boxes.findIndex(b => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height);
  };

  // The loop.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      sync();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sync]);

  // Whatever points at a pane makes it the editing pane, BEFORE any other handler sees the event: a
  // pointerdown precedes every mousedown and click (picking, the gizmo, the brushes), and the capture phase
  // on the viewport precedes the canvas's own wheel listener, which feeds the camera's zoom.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]');
    const focusFrom = (e: { clientX: number; clientY: number; target: EventTarget | null }) => {
      if (!paneView().active || inOverlay(e.target) || document.pointerLockElement) return;
      const index = paneAt(e.clientX, e.clientY);
      if (index >= 0) focusPane(index);
    };
    el.addEventListener('pointerdown', focusFrom, true);
    el.addEventListener('wheel', focusFrom, { capture: true, passive: true });
    return () => {
      el.removeEventListener('pointerdown', focusFrom, true);
      el.removeEventListener('wheel', focusFrom, { capture: true } as EventListenerOptions);
    };
  }, [viewportRef, focusPane]);

  // A preview that redraws only on change redraws on these. The cameras' own moves are the editor's and
  // are left out, or navigating the editing pane would redraw every preview every frame.
  useEffect(() => {
    const dirty = () => instanceRef.current?.renderer.markViewsDirty();
    const onScene = (change?: { kind?: string; node?: { isEditorOwned?: boolean } }) => {
      if (change?.kind === 'transform' && change.node?.isEditorOwned) return;
      dirty();
    };
    const events = ['SELECT_NODE', 'DEBUG_VISIBILITY_CHANGED', 'PHYSICS_CHANGED', 'GIZMO_DRAG_START', 'GIZMO_DRAG_END',
                    'TEXTURES_CHANGED'];
    eventEmitter.on('SCENE_CHANGED', onScene);
    for (const e of events) eventEmitter.on(e, dirty);
    return () => {
      eventEmitter.off('SCENE_CHANGED', onScene);
      for (const e of events) eventEmitter.off(e, dirty);
    };
  }, [eventEmitter]);

  // Poses are kept on leaving the page, not only every second.
  useEffect(() => {
    const save = () => { const scene = mainSceneRef.current; if (scene) capturePoses(scene, true); };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [capturePoses]);

  return {
    state,
    setLayout: (layout) => {
      const st = stateRef.current;
      commit({ ...st, layout, focused: Math.min(st.focused, paneCount(layout) - 1) });
    },
    setPreset: (index, preset) => {
      if (index <= 0 || index >= MAX_PANES) return;
      const st = stateRef.current;
      commit({ ...st, panes: st.panes.map((p, i) => (i === index ? { ...p, preset } : p)) });
      instanceRef.current?.renderer.markViewsDirty(index);
    },
    setRealtime: (index, realtime) => {
      const st = stateRef.current;
      commit({ ...st, panes: st.panes.map((p, i) => (i === index ? { ...p, realtime } : p)) });
    },
    focusPaneAt: (clientX, clientY) => {
      const index = paneAt(clientX, clientY);
      if (index >= 0) focusPane(index);
    },
  };
}
