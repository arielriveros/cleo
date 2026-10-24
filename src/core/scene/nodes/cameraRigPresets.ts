import type { FollowSpace } from "./cameraRigNode";
import { definePresets, type Preset } from "../../presets";

type Vec3 = [number, number, number];

/** The CameraRigNode fields a preset sets. */
export interface CameraRigPresetOptions {
    followOffset?: Vec3;
    followSpace?: FollowSpace;
    followDamping?: Vec3;
    followDampingSpace?: 'world' | 'rig';
    yawMin?: number;
    yawMax?: number;
    pitchMin?: number;
    pitchMax?: number;
    yaw?: number;
    pitch?: number;
    armLength?: number;
    socketOffset?: Vec3;
    fovEnabled?: boolean;
    fov?: number;
    fovDamping?: number;
    collisionEnabled?: boolean;
    collisionRadius?: number;
    collisionMinRatio?: number;
    collisionPullTime?: number;
    collisionReturnTime?: number;
}

/**
 * One-click camera styles for CameraRigNode. A preset sets the boom, follow lag, angle limits, FOV and
 * collision — never the aim mode (a look-at rig stays one), the follow / look-at targets, the camera pin,
 * the ignore list, input sensitivity, invert-pitch (a player preference) or shake.
 *
 * Key order is assignment order: the yaw and pitch limits land before `yaw` / `pitch`, whose setters
 * clamp against them. Only the locked-angle styles set `yaw`; the orbiting ones keep the authored heading.
 */
export type CameraRigPreset = Preset<CameraRigPresetOptions>;

const BASE: CameraRigPresetOptions = {
    followOffset: [0, 1.6, 0], followSpace: 'world', followDamping: [0.15, 0.25, 0.15], followDampingSpace: 'world',
    yawMin: -Infinity, yawMax: Infinity, pitchMin: -80, pitchMax: 80, pitch: 12,
    armLength: 4, socketOffset: [0, 0, 0],
    fovEnabled: false, fov: 60, fovDamping: 0.2,
    collisionEnabled: true, collisionRadius: 0.2, collisionMinRatio: 0.05, collisionPullTime: 0, collisionReturnTime: 0.35,
};

// Angles (see the angle-sign convention): positive pitch looks DOWN; at yaw 0 the camera looks along +Z, so
// screen-right is world -X and the rig's local +X is its LEFT.
export const CAMERA_RIG_PRESETS: CameraRigPreset[] = definePresets(BASE, [
    ['thirdPerson', 'Third-Person', 'The default: an orbiting chase camera four metres behind the target.', {}],
    ['overShoulder', 'Over-the-Shoulder', 'Close shooter framing over the right shoulder — make Socket Offset X positive for the left.',
        { armLength: 2.2, socketOffset: [-0.55, 0.15, 0], followOffset: [0, 1.55, 0], followDamping: [0.05, 0.1, 0.05],
          pitchMin: -60, pitchMax: 70, pitch: 8, collisionRadius: 0.15 }],
    ['souls', 'Souls / Action', 'A roomy action-RPG camera: tight sideways, lazy along the boom, no worm’s-eye angles.',
        { armLength: 4.5, followOffset: [0, 1.5, 0], followDamping: [0.12, 0.3, 0.3], followDampingSpace: 'rig',
          pitchMin: -45, pitchMax: 70, pitch: 15, collisionReturnTime: 0.5 }],
    ['cinematic', 'Cinematic Chase', 'A heavy, floaty follow and a long lens — trailers and cutscenes.',
        { armLength: 5.5, followDamping: [0.3, 0.5, 0.6], followDampingSpace: 'rig', pitch: 10,
          fovEnabled: true, fov: 45, fovDamping: 0.5, collisionReturnTime: 0.8 }],
    ['firstPerson', 'First-Person', 'The camera sits at eye height on the target, with no boom and no collision.',
        { armLength: 0, followOffset: [0, 1.65, 0], followDamping: [0, 0, 0],
          pitchMin: -85, pitchMax: 85, pitch: 0, collisionEnabled: false, fovEnabled: true, fov: 75 }],
    ['topDown', 'Top-Down', 'Looks down at 60° from fourteen metres, rotation locked.',
        { yawMin: 0, yawMax: 0, pitchMin: 60, pitchMax: 60, pitch: 60, armLength: 14,
          followDamping: [0.12, 0.2, 0.12], collisionEnabled: false, yaw: 0 }],
    ['isometric', 'Isometric', 'A fixed 45° / 35° view from far away through a long, flat lens.',
        { yawMin: 45, yawMax: 45, pitchMin: 35, pitchMax: 35, pitch: 35, armLength: 25,
          followDamping: [0.1, 0.15, 0.1], fovEnabled: true, fov: 25, collisionEnabled: false, yaw: 45 }],
    ['sideScroller', 'Side-Scroller', 'A locked side view of a level laid out along X, +X to the right; loose vertically, rigid in depth.',
        { yawMin: 180, yawMax: 180, pitchMin: 5, pitchMax: 5, pitch: 5, armLength: 12,
          followDamping: [0.08, 0.3, 0], collisionEnabled: false, yaw: 180 }],
]);
