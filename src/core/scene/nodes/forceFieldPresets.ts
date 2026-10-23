import type { ForceFieldOptions } from "./forceFieldNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click behaviours for ForceFieldNode: the kind of push, its shape and how hard it pushes. Never the
 * radius or box extents (how big the field is in this scene) nor `enabled`. Direction and the vortex axis
 * are the node's local +Y, so aim the field by rotating it.
 */
export type ForceFieldPreset = Preset<ForceFieldOptions>;

const BASE: ForceFieldOptions = { kind: 'directional', shape: 'sphere', strength: 5, falloff: 0.5, frequency: 0.5 };

export const FORCE_FIELD_PRESETS: ForceFieldPreset[] = definePresets(BASE, [
    ['updraft', 'Updraft', 'Carries particles along the node’s +Y — chimneys, vents, jump pads.',
        { strength: 6, falloff: 0.4 }],
    ['windTunnel', 'Wind Tunnel', 'A hard-edged box of fast, steady wind.',
        { shape: 'box', strength: 10, falloff: 0.15 }],
    ['sceneBreeze', 'Scene Breeze', 'A gentle drift applied everywhere, for smoke, dust and snow.',
        { shape: 'global', strength: 2, falloff: 0 }],
    ['explosion', 'Explosion Push', 'Throws particles outward from the centre.',
        { kind: 'radial', strength: -40, falloff: 0.8 }],
    ['attractor', 'Attractor', 'Pulls particles in toward the centre — magic, black holes, drains.',
        { kind: 'radial', strength: 15, falloff: 0.6 }],
    ['vortex', 'Vortex', 'Swirls particles around the node’s +Y axis — whirlwinds, portals.',
        { kind: 'vortex', strength: 12, falloff: 0.5 }],
    ['turbulence', 'Turbulent Air', 'Churning curl noise — fire, heat shimmer, embers.',
        { kind: 'turbulence', strength: 6, frequency: 0.6 }],
    ['gentleTurbulence', 'Gentle Turbulence', 'Slow, broad eddies over the whole scene.',
        { kind: 'turbulence', shape: 'global', strength: 2, falloff: 0, frequency: 0.25 }],
    ['drag', 'Thick Drag', 'Slows everything inside it — underwater, syrup, a stasis field.',
        { kind: 'drag', strength: 3, falloff: 0.3 }],
]);
