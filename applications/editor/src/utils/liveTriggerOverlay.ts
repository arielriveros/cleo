import { Node, ModelNode, Vec, eulerFromQuatDeg, markEditorOnly } from 'cleo';
import type { Scene, ColliderPart } from 'cleo';
import type { ShapeDescription } from '../features/EngineContext';

// The trigger volumes physics is actually testing, drawn live while the game plays (Play and Simulate,
// eye menu ▸ Triggers). The authored-map wireframes (editorHelpers section 5) only know the triggers an
// author placed in the editor; a combat game makes most of its triggers at runtime — a weapon's hitbox
// that exists between two animation events, a hurtbox on every spawned enemy, a zone a script attaches —
// and switches them on and off many times a second. So this reads the physics system instead:
//
//  - which triggers exist is rebuilt only when `physics.triggerVersion` changes (one wire per trigger,
//    all its shapes merged into one line mesh, rebuilt only when its shapes change);
//  - every frame, after every script, animator and socket follower has moved (Scene.addLateUpdate), each
//    wire is placed on its trigger's node and shown only while the trigger is enabled — so a hitbox
//    appears and vanishes on the same frame its events switch it, and a rolling character's hurtbox
//    blinks out for exactly its i-frames;
//  - colour says what it is and what it is doing: green a plain zone, cyan one that detects other
//    triggers, magenta a continuous (swept) one — a blade —, yellow while it overlaps something.
//
// Membership churn never reaches the reconciler: the wires are editor-owned helper nodes.

/** The root every live wire hangs under; one per scene. */
export const LIVE_TRIGGERS = '__debug__live_triggers';
const WIRE_PREFIX = '__debug__live_trigger_';

export const LIVE_TRIGGER_COLORS: Record<'zone' | 'detector' | 'swept' | 'overlapping', [number, number, number]> = {
  zone: [0, 1, 0],
  detector: [0, 0.85, 1],
  swept: [1, 0.2, 0.9],
  overlapping: [1, 0.9, 0],
};

/** What the overlay reads from a trigger body (an engine `Trigger`). */
export interface LiveTrigger {
  id: number;
  enabled: boolean;
  detectTriggers: boolean;
  continuous: boolean;
  shapeVersion: number;
  owner: Node | null;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
}

/** What the overlay reads from the physics system. */
export interface LiveTriggerSource {
  readonly triggers: ReadonlySet<LiveTrigger>;
  readonly triggerVersion: number;
  isTriggerOverlapping(trigger: LiveTrigger): boolean;
  /** A trigger's collision geometry as physics simulates it. */
  colliderParts(trigger: LiveTrigger): readonly ColliderPart[];
}

export type WireBuilder = (shapes: ShapeDescription[], color: [number, number, number], scale: Vec.vec3) => ModelNode | null;

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * A trigger's collider parts as the editor's shape descriptions, at their final size (shapes are scaled
 * when they are built, so these draw at scale 1). A capsule a backend built from a cylinder and a sphere on
 * each end (cannon) comes back as one capsule.
 */
export function bodyShapeDescriptions(parts: readonly ColliderPart[]): ShapeDescription[] {
  const out: ShapeDescription[] = [];
  const spheres: { index: number; c: number[]; r: number }[] = [];
  const euler = Vec.vec3.create();
  const rotationOf = (i: number): number[] => {
    const q = parts[i].rotation;
    eulerFromQuatDeg(euler, Vec.quat.fromValues(q[0], q[1], q[2], q[3]));
    return [round(euler[0]), round(euler[1]), round(euler[2])];
  };
  const offsetOf = (i: number): number[] => { const o = parts[i].offset; return [o[0], o[1], o[2]]; };

  const cylinders: { index: number; r: number; h: number; segments: number }[] = [];
  parts.forEach(({ shape }, i) => {
    if (shape.kind === 'sphere') spheres.push({ index: i, c: offsetOf(i), r: shape.radius });
    else if (shape.kind === 'box') {
      const h = shape.halfExtents;
      out.push({ type: 'box', offset: offsetOf(i), rotation: rotationOf(i), width: h[0] * 2, height: h[1] * 2, depth: h[2] * 2 });
    } else if (shape.kind === 'cylinder') {
      cylinders.push({ index: i, r: Math.max(shape.radiusTop, shape.radiusBottom), h: shape.height, segments: shape.segments || 12 });
    } else if (shape.kind === 'capsule') {
      out.push({ type: 'capsule', offset: offsetOf(i), rotation: rotationOf(i), radius: shape.radius, height: round(shape.height + 2 * shape.radius), numSegments: 12 });
    } else if (shape.kind === 'convex') {
      out.push({
        type: 'convex', offset: offsetOf(i), rotation: rotationOf(i), quality: 'medium',
        vertices: shape.hull.vertices.map(v => [v[0], v[1], v[2]]), faces: shape.hull.faces.map(f => [...f]),
      });
    }
  });

  const used = new Set<number>();
  for (const cyl of cylinders) {
    const q = parts[cyl.index].rotation;
    const half = Vec.vec3.transformQuat(Vec.vec3.create(), [0, cyl.h / 2, 0], Vec.quat.fromValues(q[0], q[1], q[2], q[3]));
    const o = offsetOf(cyl.index);
    const ends = [[o[0] + half[0], o[1] + half[1], o[2] + half[2]], [o[0] - half[0], o[1] - half[1], o[2] - half[2]]];
    const caps = ends.map(e => spheres.find(s => !used.has(s.index) && Math.abs(s.r - cyl.r) < 1e-6
      && Math.hypot(s.c[0] - e[0], s.c[1] - e[1], s.c[2] - e[2]) < 1e-4));
    if (caps[0] && caps[1]) {
      used.add(caps[0].index); used.add(caps[1].index);
      out.push({ type: 'capsule', offset: o, rotation: rotationOf(cyl.index), radius: cyl.r, height: round(cyl.h + 2 * cyl.r), numSegments: cyl.segments });
    } else {
      out.push({ type: 'cylinder', offset: o, rotation: rotationOf(cyl.index), radius: cyl.r, height: cyl.h, numSegments: cyl.segments });
    }
  }
  for (const s of spheres) if (!used.has(s.index)) out.push({ type: 'sphere', offset: s.c, rotation: [0, 0, 0], radius: s.r });
  return out;
}

type Tint = keyof typeof LIVE_TRIGGER_COLORS;
const tintOf = (t: LiveTrigger, overlapping: boolean): Tint =>
  overlapping ? 'overlapping' : t.continuous ? 'swept' : t.detectTriggers ? 'detector' : 'zone';

interface Wire { node: ModelNode | null; shapeVersion: number; tint: Tint | null }
interface OverlayState { version: number; wires: Map<LiveTrigger, Wire>; off: () => void }
const states = new WeakMap<Node, OverlayState>();

/**
 * Keep one live wire per trigger of `source` under a `__debug__live_triggers` root in `scene`, placed every
 * frame. Idempotent: the reconciler calls it on every pass; only the first builds anything.
 */
export function ensureLiveTriggerOverlay(scene: Scene, source: LiveTriggerSource, buildWire: WireBuilder): Node {
  let root = scene.getNodesByName(LIVE_TRIGGERS)[0];
  if (!root) {
    root = new Node(LIVE_TRIGGERS);
    markEditorOnly(root);
    scene.addNode(root);
  }
  if (states.has(root)) return root;
  const state: OverlayState = { version: -1, wires: new Map(), off: () => {} };
  states.set(root, state);
  const owner = root;
  state.off = scene.addLateUpdate(() => tickLiveTriggers(owner, source, buildWire));
  return root;
}

/** Take the overlay out of `scene`: its late update, its wires and their buffers. */
export function dropLiveTriggerOverlay(scene: Scene): void {
  for (const root of scene.getNodesByName(LIVE_TRIGGERS)) {
    const state = states.get(root);
    if (state) { state.off(); disposeWires(root, state); states.delete(root); }
    scene.removeNode(root);
  }
}

function disposeWires(root: Node, state: OverlayState): void {
  for (const wire of state.wires.values()) if (wire.node) { root.removeChild(wire.node); wire.node.dispose(); }
  state.wires.clear();
}

const position = Vec.vec3.create();
const rotation = Vec.quat.create();

/** One frame of the overlay. Exported for tests. */
export function tickLiveTriggers(root: Node, source: LiveTriggerSource, buildWire: WireBuilder): void {
  const state = states.get(root);
  if (!state) return;
  // Removed from its scene by something else: stop ticking.
  if (!root.scene) { state.off(); disposeWires(root, state); states.delete(root); return; }

  if (source.triggerVersion !== state.version) {
    state.version = source.triggerVersion;
    for (const [trigger, wire] of state.wires) {
      if (source.triggers.has(trigger)) continue;
      if (wire.node) { root.removeChild(wire.node); wire.node.dispose(); }
      state.wires.delete(trigger);
    }
    for (const trigger of source.triggers) {
      const wire = state.wires.get(trigger);
      if (wire && wire.shapeVersion === trigger.shapeVersion) continue;
      if (wire?.node) { root.removeChild(wire.node); wire.node.dispose(); }
      const tint = tintOf(trigger, false);
      const node = buildWire(bodyShapeDescriptions(source.colliderParts(trigger)), LIVE_TRIGGER_COLORS[tint], [1, 1, 1]);
      if (node) { node.name = `${WIRE_PREFIX}${trigger.id}`; root.addChild(node); }
      state.wires.set(trigger, { node, shapeVersion: trigger.shapeVersion, tint });
    }
  }

  for (const [trigger, wire] of state.wires) {
    const node = wire.node;
    if (!node) continue;
    node.visible = trigger.enabled;
    if (!trigger.enabled) continue;
    // The node's pose as it is about to be drawn (this runs after the socket followers), which is where
    // physics will test the trigger next; an ownerless trigger has only its body pose.
    const owner = trigger.owner;
    if (owner && owner.scene) {
      const p = owner.worldPosition, q = owner.worldQuaternion;
      Vec.vec3.set(position, p[0], p[1], p[2]);
      Vec.quat.set(rotation, q[0], q[1], q[2], q[3]);
    } else {
      Vec.vec3.set(position, trigger.position.x, trigger.position.y, trigger.position.z);
      Vec.quat.set(rotation, trigger.quaternion.x, trigger.quaternion.y, trigger.quaternion.z, trigger.quaternion.w);
    }
    node.setPosition(position);
    node.setQuaternion(rotation);
    const tint = tintOf(trigger, source.isTriggerOverlapping(trigger));
    if (tint !== wire.tint) {
      wire.tint = tint;
      node.model.material.properties.set('color', LIVE_TRIGGER_COLORS[tint]);
    }
  }
}
