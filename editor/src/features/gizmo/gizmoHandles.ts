import { vec3, quat, mat3 } from 'gl-matrix';
import type { ReadonlyVec3 } from 'gl-matrix';
import { Model, ModelNode, Material } from 'cleo';
import { GizmoGeometry } from '../../utils/GizmoGeometry';
import type { GizmoMode } from '../engineContextTypes';
import {
    AXIS_IDS,
    PLANE_IDS,
    PLANE_AXES,
    HANDLE_LENGTH,
    PLANE_MIN_FACING,
    CENTRE_RADIUS,
    RING_RADIUS,
    planeQuadGeometry,
    axisIndexOf,
    isAxisId,
    isPlaneId,
    type HandleId,
    type GizmoFrame,
} from './gizmoPick';

/**
 * The gizmo's drawable handles: which ones a mode has, the scene nodes that draw them, and where those
 * nodes go each frame.
 *
 * Split from the controller so the naming contract below can be unit-tested with no DOM and no GL, and
 * split from `gizmoPick` so what you SEE and what you CLICK are derived from the same placement call
 * (`planeQuadGeometry`) rather than from two descriptions that can drift apart.
 */

/**
 * Every handle node's name must contain BOTH substrings, and neither is decorative:
 *
 * - `__editor__` is what `EngineProvider`'s dirty guard keys on. These nodes live in the user's scene and
 *   are re-placed every frame, so each placement emits SCENE_CHANGED; without the substring, merely
 *   selecting a node and orbiting would mark the project unsaved forever.
 * - `gizmo` is the exception `Raycaster.raycast` carves out of its `__editor__` skip list. The gizmo does
 *   its own analytic picking and no longer needs to be raycastable, but keeping the substring leaves
 *   raycast membership exactly as it was rather than changing two things at once.
 *
 * `tests/gizmoContract.test.ts` pins both.
 */
export const HANDLE_NAME_PREFIX = '__editor__gizmo__';

const AXIS_COLORS: [number, number, number][] = [
    [0.94, 0.26, 0.28],   // X
    [0.42, 0.82, 0.24],   // Y
    [0.26, 0.52, 0.96],   // Z
];
const CENTRE_COLOR: [number, number, number] = [0.85, 0.85, 0.88];

const css = (c: [number, number, number]) => `rgb(${c.map(v => Math.round(v * 255)).join(' ')})`;
/** The same palette as CSS, so the SVG readout and the 3D handles can never drift apart. */
export const AXIS_CSS_COLORS: [string, string, string] = [css(AXIS_COLORS[0]), css(AXIS_COLORS[1]), css(AXIS_COLORS[2])];
export const CENTRE_CSS_COLOR = css(CENTRE_COLOR);

/** How much a handle brightens under the cursor, and how far the others dim while one is being dragged. */
const HOVER_GAIN = 1.6;
const IDLE_DIM = 0.35;

export type HandleShape = 'arrow' | 'arm' | 'ring' | 'quad' | 'sphere';

export interface HandleSpec {
    id: HandleId;
    name: string;
    shape: HandleShape;
    /**
     * Axis index the handle's +Y geometry is turned onto: the axis itself for arrows, arms and rings,
     * and the plane's NORMAL for a quad. Null for the centre sphere, which has no orientation.
     */
    axis: number | null;
    color: [number, number, number];
}

/**
 * The handles a mode shows.
 *
 * Rotation gets three rings and nothing else. Move and scale share the axis + plane + centre set, where
 * the centre means "drag in the screen plane" and "scale uniformly" respectively.
 */
export function handleSpecs(mode: GizmoMode): HandleSpec[] {
    const specs: HandleSpec[] = [];

    if (mode === 'rotation') {
        for (let i = 0; i < 3; i++)
            specs.push({ id: AXIS_IDS[i], name: `${HANDLE_NAME_PREFIX}ring_${AXIS_IDS[i]}`, shape: 'ring', axis: i, color: AXIS_COLORS[i] });
        return specs;
    }

    // Drawn before the axes so that, with depth testing off, the axes win the overlap at the origin.
    specs.push({ id: 'screen', name: `${HANDLE_NAME_PREFIX}centre`, shape: 'sphere', axis: null, color: CENTRE_COLOR });

    for (const id of PLANE_IDS) {
        const [i1, i2] = PLANE_AXES[id];
        const normal = 3 - i1 - i2;
        specs.push({ id, name: `${HANDLE_NAME_PREFIX}plane_${id}`, shape: 'quad', axis: normal, color: AXIS_COLORS[normal] });
    }

    const shape: HandleShape = mode === 'scale' ? 'arm' : 'arrow';
    for (let i = 0; i < 3; i++)
        specs.push({ id: AXIS_IDS[i], name: `${HANDLE_NAME_PREFIX}${shape}_${AXIS_IDS[i]}`, shape, axis: i, color: AXIS_COLORS[i] });

    return specs;
}

export interface GizmoHandle {
    spec: HandleSpec;
    node: ModelNode;
    material: Material;
}

function geometryFor(shape: HandleShape) {
    switch (shape) {
        case 'arrow': return GizmoGeometry.Arrow(HANDLE_LENGTH);
        case 'arm': return GizmoGeometry.ScaleArm(HANDLE_LENGTH);
        case 'ring': return GizmoGeometry.Ring(RING_RADIUS);
        case 'quad': return GizmoGeometry.PlaneQuad(1);
        case 'sphere': return GizmoGeometry.Centre(CENTRE_RADIUS);
    }
}

/**
 * Build the scene nodes for a mode.
 *
 * `isGizmo` is what routes them into the renderer's editor-overlay layer, where they are drawn with the
 * depth test set to `always` — that is the "gizmos are always visible" contract, and it is a flag rather
 * than a name test on purpose (see `src/core/scene/editorNodes.ts`).
 */
export function buildHandles(mode: GizmoMode): GizmoHandle[] {
    return handleSpecs(mode).map(spec => {
        const material = Material.Basic(
            { color: [...spec.color] },
            { wireframe: false, transparent: false, castShadow: false, side: 'double' },
        );
        const node = new ModelNode(spec.name, new Model(geometryFor(spec.shape), material));
        (node as any).isGizmo = true;
        return { spec, node, material };
    });
}

/** Rotation taking local X/Y/Z onto the given world axes. */
function basisQuat(x: ReadonlyVec3, y: ReadonlyVec3, z: ReadonlyVec3): quat {
    // gl-matrix mat3 is column-major, so these nine numbers are the three columns in order.
    const m = mat3.fromValues(x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]);
    const q = quat.fromMat3(quat.create(), m);
    return quat.normalize(q, q);
}

/** Any unit vector perpendicular to `n`; the roll of an arrow or ring about its own axis is arbitrary. */
function anyPerpendicular(n: ReadonlyVec3): vec3 {
    const seed: ReadonlyVec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const out = vec3.cross(vec3.create(), n, seed);
    return vec3.normalize(out, out);
}

/** Where one handle's node should sit, given the frame. Pure, so placement can be tested and change-gated. */
export interface HandlePlacement {
    position: vec3;
    quaternion: quat;
    scale: number;
    visible: boolean;
}

export function placementFor(spec: HandleSpec, frame: GizmoFrame): HandlePlacement {
    if (spec.shape === 'sphere')
        return { position: vec3.clone(frame.origin as vec3), quaternion: quat.create(), scale: frame.scale, visible: true };

    if (spec.shape === 'quad' && isPlaneId(spec.id)) {
        const quad = planeQuadGeometry(frame, spec.id);
        // The unit quad runs 0..1 along its local X and Z, so scaling by the full width and putting the
        // node on the near corner reproduces exactly the rectangle `buildPickShapes` tests against.
        const corner = vec3.clone(quad.centre);
        vec3.scaleAndAdd(corner, corner, quad.u, -quad.half);
        vec3.scaleAndAdd(corner, corner, quad.w, -quad.half);
        // The basis must be RIGHT-handed or `quat.fromMat3` is handed a reflection and returns nonsense.
        // (u, normal, w) is left-handed half the time depending on which quadrant the quad flipped into,
        // so the middle column is rebuilt from the other two. For a flat, double-sided quad the only
        // difference is which way the normal points, which nothing here can see.
        return {
            position: corner,
            quaternion: basisQuat(quad.u, vec3.cross(vec3.create(), quad.w, quad.u), quad.w),
            scale: quad.half * 2,
            visible: quad.facing >= PLANE_MIN_FACING,
        };
    }

    const axis = frame.axes[spec.axis ?? 0];
    const x = anyPerpendicular(axis);
    const z = vec3.cross(vec3.create(), x, axis);
    return {
        position: vec3.clone(frame.origin as vec3),
        quaternion: basisQuat(x, axis, z),
        scale: frame.scale,
        visible: true,
    };
}

const EPS = 1e-5;
const near = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > EPS) return false;
    return true;
};

/**
 * Move the handle nodes onto the current frame, writing only what actually changed.
 *
 * The change gate is not micro-optimisation. Every Node setter emits SCENE_CHANGED, and this runs once
 * per animation frame for up to seven handles; without the gate a still camera would push ~20 events a
 * frame through the editor's event bus and the history recorder for no reason at all.
 *
 * @param hidden Handles the caller wants suppressed regardless of the frame (play mode, no selection).
 */
export function placeHandles(handles: GizmoHandle[], frame: GizmoFrame, hidden = false): void {
    for (const handle of handles) {
        const want = placementFor(handle.spec, frame);
        const visible = want.visible && !hidden;

        if (handle.node.visible !== visible) handle.node.visible = visible;
        if (!visible) continue;

        if (!near(handle.node.position, want.position)) handle.node.setPosition(want.position);
        if (!near(handle.node.quaternion, want.quaternion)) handle.node.setQuaternion(want.quaternion);
        const scale = handle.node.scale;
        if (Math.abs(scale[0] - want.scale) > EPS) handle.node.setScale([want.scale, want.scale, want.scale]);
    }
}

/**
 * Tint the handles for the current interaction: the active one bright, and — while a drag is running —
 * every other one dimmed, so the axis being changed is unmistakable.
 *
 * Writes straight into `Material.properties`, which is a plain Map and emits nothing, so this stays off
 * the scene-change path entirely.
 */
export function tintHandles(handles: GizmoHandle[], hovered: HandleId | null, dragging: HandleId | null): void {
    const active = dragging ?? hovered;
    for (const handle of handles) {
        const isActive = handle.spec.id === active;
        const gain = isActive ? HOVER_GAIN : dragging ? IDLE_DIM : 1;
        handle.material.properties.set('color', handle.spec.color.map(c => Math.min(1, c * gain)));
    }
}

/** True when a mode's handle set is the axis/plane/centre one rather than the rotation rings. */
export const hasPlaneHandles = (mode: GizmoMode): boolean => mode !== 'rotation';

/** Handle ids that act on a single axis, for callers that need the axis index. */
export const handleAxisIndex = (id: HandleId): number | null => (isAxisId(id) ? axisIndexOf(id) : null);
