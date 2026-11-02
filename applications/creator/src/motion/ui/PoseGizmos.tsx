import { useEffect, useRef, useState } from 'react';
import { quat, vec3 } from 'gl-matrix';
import { Node, Raycaster, type CleoEngine, type Scene } from 'cleo';
import TransformGizmoView, { type GizmoBus } from '@cleo/app-kit/gizmo/TransformGizmo';
import type { TransformPatch } from '@cleo/app-kit/gizmo/gizmoDrag';
import { solvedPoseLocals } from '../bakeMotion';
import type { MotionPose } from '../motionDoc';
import { modelPose, type MotionRig } from '../motionRig';
import { dragJoint, rotateBone, type DragOptions } from '../poseDrag';
import type { MotionStage } from './motionStage';

// Posing in the viewport. Click a joint of the drawn skeleton to select its bone; drag it and the limb
// follows (poseDrag.ts: FABRIK with lengths kept, or a stretch); the selected bone carries the shared
// rotate rings (app-kit's transform gizmo, the editor's own) on an invisible proxy node parked on the
// joint, as the editor's BoneGizmo does. Everything lands in the pose document, the same values the
// sliders edit. While the Parts tab is showing, a click on a joint adds its bone to the selected part (or
// takes it out) instead.
//
// A joint drag turns the camera off the way a gizmo drag does (GIZMO_DRAG_START / END on the bus), so the
// left button that grabbed a joint never also orbits. Listeners sit on the DOCUMENT, after the gizmo's
// own on the viewport: a press the rings took arrives here already `defaultPrevented`.

const PROXY = 'Motion stage · bone gizmo';
/** A press that moves no further than this is a click. */
const CLICK_PX = 5;

interface Props {
  instance: CleoEngine | null;
  scene: Scene | null;
  bus: GizmoBus & { on(event: string, fn: (...a: any[]) => void): unknown; off(event: string, fn: (...a: any[]) => void): unknown };
  viewportRef: React.RefObject<HTMLDivElement>;
  stage: React.MutableRefObject<MotionStage | null>;
  rig: MotionRig | null;
  /** The pose being edited. */
  pose: MotionPose;
  setPose: (p: MotionPose) => void;
  bone: string | null;
  setBone: (name: string | null) => void;
  /** False outside Pose view: a joint press switches to it. */
  posing: boolean;
  startPosing: () => void;
  /** Joints are pickable only while the skeleton is drawn. */
  skeleton: boolean;
  options: DragOptions;
  /**
   * While set (the Parts tab is showing), a click on a joint goes here -- the bone joins or leaves the
   * selected part -- instead of selecting or dragging it.
   */
  onJointPick?: (bone: string) => void;
}

export function PoseGizmos(props: Props) {
  const { instance, scene, bus, viewportRef, stage, rig, pose, bone, posing } = props;
  const live = useRef(props);
  live.current = props;
  const ringDragging = useRef(false);
  const lastDragEnd = useRef(0);

  // --- The rotate rings' proxy: on the selected joint whenever the rings are not being dragged ---
  const [proxyId, setProxyId] = useState<string | null>(null);
  const proxy = useRef<Node | null>(null);
  useEffect(() => {
    if (!scene) return;
    const n = new Node(PROXY);
    scene.addNode(n);
    proxy.current = n;
    setProxyId(n.id);
    return () => { scene.removeNode(n); proxy.current = null; setProxyId(null); };
  }, [scene]);
  const boneIndex = rig && bone ? rig.byName.get(bone) : undefined;
  /** Put the proxy on the selected joint, as the pose shows it. */
  const park = () => {
    const { rig: r, pose: p, bone: b } = live.current;
    const n = proxy.current, s = stage.current;
    const i = r && b ? r.byName.get(b) : undefined;
    if (!n || !s || !r || i === undefined || ringDragging.current) return;
    const model = modelPose(r.bones, solvedPoseLocals(r, p));
    n.setPosition(s.worldOf(model.pos[i]));
    n.setQuaternion(quat.normalize(quat.create(), model.rot[i]));
  };
  useEffect(park, [rig, pose, boneIndex, stage, proxyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Only the rings' own drags hold the proxy still (they name it); a joint drag re-parks it as it goes.
    const start = (info?: { nodeId?: string }) => { if (info?.nodeId && info.nodeId === proxy.current?.id) ringDragging.current = true; };
    const end = () => { ringDragging.current = false; lastDragEnd.current = performance.now(); park(); };
    bus.on('GIZMO_DRAG_START', start);
    bus.on('GIZMO_DRAG_END', end);
    return () => { bus.off('GIZMO_DRAG_START', start); bus.off('GIZMO_DRAG_END', end); };
  }, [bus]);

  const onRing = (_id: string, patch: TransformPatch) => {
    const { rig: r, pose: p, bone: b, setPose } = live.current;
    const i = r && b ? r.byName.get(b) : undefined;
    if (!r || i === undefined || patch.kind !== 'rotation') return;
    // The proxy is top-level and the character root only scales: its rotation is the bone's model rotation.
    proxy.current?.setQuaternion(patch.localQuat);
    const next = rotateBone(r, p, i, patch.localQuat);
    stage.current?.showPoseNow(r, next);
    setPose(next);
  };

  // --- Joints: hover, click to select, drag to pose ---
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !instance) return;
    /**
     * The joint under the cursor: of the joints whose drawn sphere (half as big again) the ray passes
     * through, the one it passes closest to the centre of -- among a hand's crowded fingers, the one you
     * pointed at, not whichever is nearest the camera. Depth breaks near-ties.
     */
    const pick = (e: MouseEvent): { joint: number; world: vec3 } | null => {
      const { rig: r, pose: p, skeleton } = live.current;
      const s = stage.current, cam = instance.scene?.activeCamera?.camera;
      if (!r || !s || !cam || !skeleton) return null;
      const rect = el.getBoundingClientRect();
      const ray = Raycaster.screenToRay(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, cam);
      const model = modelPose(r.bones, solvedPoseLocals(r, p));
      let best: { joint: number; world: vec3; t: number; score: number } | null = null;
      r.bones.forEach((b, i) => {
        if (!b.joint) return;
        const w = s.worldOf(model.pos[i]);
        const toJoint = vec3.sub(vec3.create(), w, ray.origin as vec3);
        const t = vec3.dot(toJoint, ray.direction as vec3);
        if (t <= 0) return;
        const miss = vec3.length(vec3.scaleAndAdd(vec3.create(), toJoint, ray.direction as vec3, -t));
        const score = miss / s.jointRadius(w);
        if (score > 1.5) return;
        if (!best || score < best.score - 0.15 || (Math.abs(score - best.score) <= 0.15 && t < best.t)) best = { joint: i, world: w, t, score };
      });
      return best;
    };
    const inViewport = (e: MouseEvent) => el.contains(e.target as globalThis.Node) && !(e.target as HTMLElement | null)?.closest?.('[data-cleo-overlay]');

    let drag: {
      joint: number; startPose: MotionPose; plane: { point: vec3; normal: vec3 }; down: { x: number; y: number };
      moved: boolean; pending: MotionPose | null; raf: number;
    } | null = null;

    const commit = () => {
      if (!drag) return;
      drag.raf = 0;
      if (drag.pending) { live.current.setPose(drag.pending); drag.pending = null; }
    };
    const finish = (cancel: boolean) => {
      if (!drag) return;
      if (drag.raf) cancelAnimationFrame(drag.raf);
      const d = drag;
      drag = null;
      if (cancel) { if (d.moved) { live.current.setPose(d.startPose); stage.current?.showPoseNow(live.current.rig!, d.startPose); } }
      else if (d.pending) live.current.setPose(d.pending);
      el.style.cursor = '';
      lastDragEnd.current = performance.now();
      bus.emit('GIZMO_DRAG_END');
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented || !inViewport(e)) return;
      if (performance.now() - lastDragEnd.current < 150) return;
      const hit = pick(e);
      if (!hit) return;
      const { rig: r, pose: p, setBone, posing: inPose, startPosing, onJointPick } = live.current;
      if (!r) return;
      e.preventDefault();
      if (onJointPick) { onJointPick(r.bones[hit.joint].name); return; }
      setBone(r.bones[hit.joint].name);
      if (!inPose) startPosing();
      const cam = instance.scene?.activeCamera?.camera;
      // The drag plane: through the joint, facing the camera.
      const normal = vec3.sub(vec3.create(), cam ? (cam.position as vec3) : [0, 0, 1], hit.world);
      vec3.normalize(normal, normal);
      drag = { joint: hit.joint, startPose: p, plane: { point: hit.world, normal }, down: { x: e.clientX, y: e.clientY }, moved: false, pending: null, raf: 0 };
      el.style.cursor = 'grabbing';
      bus.emit('GIZMO_DRAG_START', { joint: r.bones[hit.joint].name });
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) {
        // Hover: mark the joint a press would take.
        if (!inViewport(e) || e.buttons) return;
        const hit = pick(e);
        const name = hit && live.current.rig ? live.current.rig.bones[hit.joint].name : null;
        stage.current?.setHoverBone(name);
        el.style.cursor = name ? 'grab' : '';
        return;
      }
      if (!drag.moved && Math.hypot(e.clientX - drag.down.x, e.clientY - drag.down.y) <= CLICK_PX) return;
      drag.moved = true;
      const { rig: r, options } = live.current;
      const s = stage.current, cam = instance.scene?.activeCamera?.camera;
      if (!r || !s || !cam) return;
      const rect = el.getBoundingClientRect();
      const ray = Raycaster.screenToRay(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, cam);
      const denom = vec3.dot(drag.plane.normal, ray.direction as vec3);
      if (Math.abs(denom) < 1e-6) return;
      const t = vec3.dot(vec3.sub(vec3.create(), drag.plane.point, ray.origin as vec3), drag.plane.normal) / denom;
      const world = vec3.scaleAndAdd(vec3.create(), ray.origin as vec3, ray.direction as vec3, t);
      const next = dragJoint(r, drag.startPose, drag.joint, s.modelOf(world), options);
      // The stage shows it now; the document (and the full rebake) follows once a frame.
      s.showPoseNow(r, next);
      drag.pending = next;
      if (!drag.raf) drag.raf = requestAnimationFrame(commit);
    };
    const onUp = () => { if (drag) finish(false); };
    const onKey = (e: KeyboardEvent) => { if (drag && e.key === 'Escape') { e.preventDefault(); finish(true); } };
    const onLeave = () => { if (!drag) { stage.current?.setHoverBone(null); el.style.cursor = ''; } };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      finish(true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey);
      el.removeEventListener('mouseleave', onLeave);
      stage.current?.setHoverBone(null);
    };
  }, [instance, viewportRef, bus, stage]);

  return (
    <TransformGizmoView instance={instance} scene={scene} bus={bus}
                        selectedNodeId={posing && boneIndex !== undefined ? proxyId : null}
                        mode='rotation' space='local' onTransformChange={onRing} viewportRef={viewportRef} />
  );
}
