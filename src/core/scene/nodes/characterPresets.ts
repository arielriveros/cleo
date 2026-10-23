import type { FacingMode } from "../../control/locomotion";
import { definePresets, type Preset } from "../../presets";

/** The CharacterNode movement fields a preset sets. */
export interface CharacterPresetOptions {
    walkSpeed?: number;
    runSpeed?: number;
    jumpSpeed?: number;
    turnSpeed?: number;
    turnThreshold?: number;
    turnReleaseAngle?: number;
    turnSettleSeconds?: number;
    directionSmoothing?: number;
    acceleration?: number;
    airControl?: number;
    coyoteSeconds?: number;
    jumpBufferSeconds?: number;
    jumpLockoutSeconds?: number;
    facingMode?: FacingMode;
}

/**
 * One-click movement feels for CharacterNode. Every movement field, never `driveWhenUnpossessed`. Speeds
 * change what the locomotion clips are asked to cover, so check for foot sliding after switching.
 */
export type CharacterPreset = Preset<CharacterPresetOptions>;

const BASE: CharacterPresetOptions = {
    walkSpeed: 1.5, runSpeed: 4, jumpSpeed: 4,
    turnSpeed: 540, turnThreshold: 90, turnReleaseAngle: 10, turnSettleSeconds: 0.12,
    directionSmoothing: 0.12, acceleration: 0, airControl: 1,
    coyoteSeconds: 0.12, jumpBufferSeconds: 0.15, jumpLockoutSeconds: 0.15,
    facingMode: 'aim',
};

export const CHARACTER_PRESETS: CharacterPreset[] = definePresets(BASE, [
    ['default', 'Default', 'Engine defaults: a strafing character that starts and stops instantly.', {}],
    ['arcade', 'Arcade', 'Fast and forgiving: snaps to full speed, turns on a dime, steers freely in the air.',
        { walkSpeed: 2, runSpeed: 6, jumpSpeed: 5.5, turnSpeed: 1080, directionSmoothing: 0.05,
          coyoteSeconds: 0.15, jumpBufferSeconds: 0.2, facingMode: 'velocity' }],
    ['platformer', 'Platformer', 'High jumps, generous coyote time and jump buffering, near-full air control.',
        { walkSpeed: 2.5, runSpeed: 7, jumpSpeed: 7, turnSpeed: 1440, directionSmoothing: 0.04, acceleration: 40,
          airControl: 0.9, coyoteSeconds: 0.15, jumpBufferSeconds: 0.2, jumpLockoutSeconds: 0.1, facingMode: 'velocity' }],
    ['souls', 'Souls-like', 'Deliberate and committed: ramps up, turns heavily, almost no steering mid-jump.',
        { walkSpeed: 1.6, runSpeed: 5, jumpSpeed: 3.5, turnSpeed: 360, turnThreshold: 70, directionSmoothing: 0.18,
          acceleration: 10, airControl: 0.1, coyoteSeconds: 0.08, jumpBufferSeconds: 0.12, facingMode: 'velocity' }],
    ['realistic', 'Realistic / Weighty', 'Human momentum: slow to accelerate and turn, committed to a jump once airborne.',
        { walkSpeed: 1.4, runSpeed: 3.8, jumpSpeed: 3.2, turnSpeed: 240, turnThreshold: 60, turnSettleSeconds: 0.2,
          directionSmoothing: 0.25, acceleration: 6, airControl: 0.05, coyoteSeconds: 0.05, jumpBufferSeconds: 0.1,
          facingMode: 'velocity' }],
    ['shooter', 'Shooter (Strafe)', 'Faces where it aims and strafes; quick, with some air control.',
        { walkSpeed: 2, runSpeed: 5.5, jumpSpeed: 4.5, turnSpeed: 720, directionSmoothing: 0.08, acceleration: 30,
          airControl: 0.4, facingMode: 'aim' }],
]);
