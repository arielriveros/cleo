// The cameras' declared properties (see declare.ts): Camera and Camera Rig.

import { Vec3, CollisionMask } from '../core/scripting/fieldTypes';
import { Choice } from '../core/properties/types';
import { Node } from '../core/scene/nodes/node';
import { CameraNode } from '../core/scene/nodes/cameraNode';
import { CameraRigNode } from '../core/scene/nodes/cameraRigNode';
import { declareProperties, nodeIdAccess } from './declare';

/** The nearest Camera Rig above a camera, if any: the rig drives its transform, and maybe its FOV. */
export function rigOfCamera(node: Node): CameraRigNode | null {
    for (let n = node.parent; n; n = n.parent) if (n instanceof CameraRigNode) return n;
    return null;
}

const perspective = (n: CameraNode) => n.camera.type === 'perspective';
const ortho = (n: CameraNode) => n.camera.type === 'orthographic';
/** Not the node itself, nor what is under it: a camera focusing on its own rig's child, a rig following its camera. */
const outside = <T extends Node>(n: T, candidate: Node) => candidate !== n && !candidate.isDescendantOf(n);

declareProperties(CameraNode, 'Camera', [
    { title: '', props: [
        { key: 'camera.type', label: 'Type', type: Choice(['perspective', 'orthographic'], ['Perspective', 'Orthographic']) },
        { key: 'camera.fov', label: 'Field of View', type: Number, min: 1, max: 179, step: 1,
          when: n => perspective(n) && !rigOfCamera(n)?.fovEnabled },
        { key: 'camera.viewmodelFov', label: 'Viewmodel FOV', type: Number, min: 0, max: 120, step: 1, when: perspective },
        { key: 'camera.near', label: 'Near', type: Number },
        { key: 'camera.far', label: 'Far', type: Number, divider: true },
        { key: 'focusTargetId', label: 'Focus Target', type: Node, accepts: outside, ...nodeIdAccess<CameraNode>('focusTargetId') },
        { key: 'camera.left', label: 'Left', type: Number, when: ortho },
        { key: 'camera.right', label: 'Right', type: Number, when: ortho },
        { key: 'camera.bottom', label: 'Bottom', type: Number, when: ortho },
        { key: 'camera.top', label: 'Top', type: Number, when: ortho },
    ] },
], 'camera');

const yawLimited = (n: CameraRigNode) => isFinite(n.yawMin) || isFinite(n.yawMax);

declareProperties(CameraRigNode, 'Camera Rig', [
    { title: 'Follow (drives position)', props: [
        { key: 'followId', label: 'Follow Target', type: Node, accepts: outside, ...nodeIdAccess<CameraRigNode>('followId') },
        { key: 'followOffset', label: 'Offset (Y = Height)', type: Vec3, step: 0.05 },
        { key: 'followSpace', label: 'Offset Space', type: Choice(['world', 'targetYaw', 'targetFull'], ['World', "Target's heading", "Target's full rotation"]) },
        { key: 'followDamping', label: 'Damping (seconds)', type: Vec3, step: 0.01 },
        { key: 'followDampingSpace', label: 'Damping Axes', type: Choice(['world', 'rig'], ['World', 'Rig (behind / side / up)']) },
    ] },
    { title: 'Aim (drives rotation)', props: [
        { key: 'aimMode', label: 'Aim Mode', type: Choice(['orbit', 'lookAt', 'none'], ['Orbit (script-driven)', 'Look At target', 'None (authored rotation)']) },
        { key: 'lookAtId', label: 'Look At Target', type: Node, accepts: outside, when: n => n.aimMode === 'lookAt', ...nodeIdAccess<CameraRigNode>('lookAtId') },
        { key: 'lookAtOffset', label: 'Look At Offset', type: Vec3, step: 0.05, when: n => n.aimMode === 'lookAt' },
        { key: 'aimDamping', label: 'Aim Damping', type: Number, min: 0, max: 2, step: 0.01, when: n => n.aimMode === 'lookAt' },
        { key: 'yaw', type: Number, min: -180, max: 180, step: 0.5, readout: v => v.toFixed(1), when: n => n.aimMode !== 'none' },
        // A locked pitch (min = max) still needs a slider with some width to draw.
        { key: 'pitch', type: Number, min: n => n.pitchMin, max: n => Math.max(n.pitchMax, n.pitchMin + 1), step: 0.5,
          readout: v => v.toFixed(1), when: n => n.aimMode !== 'none' },
        { key: 'yawSensitivity', type: Number, min: 0.01, max: 2, step: 0.01, when: n => n.aimMode === 'orbit' },
        { key: 'pitchSensitivity', type: Number, min: 0.01, max: 2, step: 0.01, when: n => n.aimMode === 'orbit' },
        { key: 'invertPitch', type: Boolean, when: n => n.aimMode === 'orbit' },
        // Full ranges on both ends: a locked view (Top-Down's 60 / 60) is a limit pair on one side.
        { key: 'pitchMin', type: Number, min: -89, max: 89, step: 1, readout: v => v.toFixed(0) },
        { key: 'pitchMax', type: Number, min: -89, max: 89, step: 1, readout: v => v.toFixed(0) },
        // Infinity is not a slider value: an unlimited yaw is the switch off.
        { key: 'yawLimited', label: 'Limit Yaw', type: Boolean, get: yawLimited,
          set: (n, on) => { n.yawMin = on ? -180 : -Infinity; n.yawMax = on ? 180 : Infinity; } },
        { key: 'yawMin', type: Number, min: -180, max: 180, step: 1, readout: v => v.toFixed(0), when: yawLimited },
        { key: 'yawMax', type: Number, min: -180, max: 180, step: 1, readout: v => v.toFixed(0), when: yawLimited },
    ] },
    { title: 'Spring Arm', props: [
        { key: 'armLength', type: Number, min: 0, max: 30, step: 0.1 },
        { key: 'socketOffset', type: Vec3, step: 0.05 },
    ] },
    { title: 'Field of View', props: [
        { key: 'fovEnabled', label: 'Rig Controls FOV', type: Boolean },
        { key: 'fov', label: 'FOV', type: Number, min: 20, max: 120, step: 0.5, readout: v => v.toFixed(1), when: n => n.fovEnabled },
        { key: 'fovDamping', label: 'FOV Damping', type: Number, min: 0, max: 2, step: 0.01, when: n => n.fovEnabled },
    ] },
    { title: 'Collision', props: [
        { key: 'collisionEnabled', label: 'Handle Obstruction', type: Boolean },
        { key: 'collisionLayers', label: 'Blocked by', type: CollisionMask, when: n => n.collisionEnabled },
        { key: 'seeThroughLayers', label: 'See through', type: CollisionMask, when: n => n.collisionEnabled },
        { key: 'collisionRadius', label: 'Probe Radius', type: Number, min: 0, max: 2, step: 0.01, when: n => n.collisionEnabled },
        { key: 'collisionMinRatio', label: 'Min Arm Ratio', type: Number, min: 0, max: 0.9, step: 0.01, when: n => n.collisionEnabled },
        { key: 'collisionPullTime', label: 'Pull In Time', type: Number, min: 0, max: 1, step: 0.01, when: n => n.collisionEnabled },
        { key: 'collisionReturnTime', label: 'Return Time', type: Number, min: 0, max: 2, step: 0.01, when: n => n.collisionEnabled },
        { key: 'ditherRadius', label: 'Hole Radius', type: Number, min: 0.1, max: 4, step: 0.05, when: n => n.collisionEnabled && n.seeThroughLayers !== 0 },
        { key: 'ditherStrength', label: 'Hole Strength', type: Number, min: 0, max: 1, step: 0.01, when: n => n.collisionEnabled && n.seeThroughLayers !== 0 },
    ] },
    { title: 'Shake', props: [
        { key: 'shakePositionAmplitude', label: 'Position Amplitude', type: Vec3, step: 0.01 },
        { key: 'shakeRotationAmplitude', label: 'Rotation Amplitude (deg)', type: Vec3, step: 0.1 },
        { key: 'shakeFrequency', label: 'Frequency (Hz)', type: Number, min: 1, max: 60, step: 0.5, readout: v => v.toFixed(1) },
        { key: 'shakeDecay', label: 'Decay (per second)', type: Number, min: 0.1, max: 5, step: 0.05 },
    ] },
]);
