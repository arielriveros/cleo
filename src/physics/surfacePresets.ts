import { definePresets, type Preset } from "../core/presets";

/** The rigid-body contact fields a surface preset sets. */
export interface PhysicsSurfaceOptions {
    friction?: number;
    restitution?: number;
}

/**
 * What a rigid body is made of, as far as contacts go. Two bodies combine as min(friction) and
 * max(restitution), so the deliberately set value wins: an ice block slides on anything, a rubber ball
 * bounces off a dead wall. Never touches mass, damping, shapes or channels.
 */
export type PhysicsSurfacePreset = Preset<PhysicsSurfaceOptions>;

export const PHYSICS_SURFACE_PRESETS: PhysicsSurfacePreset[] = definePresets<PhysicsSurfaceOptions>(
    { friction: 0.3, restitution: 0 }, [
    ['default', 'Default', 'Friction 0.3, no bounce — the engine default.', {}],
    ['frictionless', 'Frictionless (Character)', 'Velocity-driven characters: any friction fights their own movement and slows them on slopes.',
        { friction: 0 }],
    ['ice', 'Ice', 'Slides on everything.', { friction: 0.02, restitution: 0.05 }],
    ['wood', 'Wood', 'Moderate grip and a dull knock of a bounce.', { friction: 0.45, restitution: 0.2 }],
    ['metal', 'Metal', 'Slick and a little lively.', { friction: 0.35, restitution: 0.15 }],
    ['stone', 'Stone', 'Grippy and dead.', { friction: 0.6, restitution: 0.05 }],
    ['rubber', 'Rubber', 'Very grippy and springy.', { friction: 0.9, restitution: 0.6 }],
    ['bouncy', 'Bouncy Ball', 'Keeps most of its speed on every bounce.', { friction: 0.5, restitution: 0.9 }],
    ['sticky', 'Sticky / Mud', 'Full grip, no bounce — nothing slides off it.', { friction: 1, restitution: 0 }],
]);
