import type { ForceFieldOptions } from "./forceFieldNode";
import { definePresets, type Preset } from "../../presets";

/**
 * One-click behaviours for ForceFieldNode: the kind of push, its shape, how hard it pushes and whether it
 * moves the scene's air. Never the radius or box extents (how big the field is in this scene) nor
 * `enabled`. Direction and the vortex axis are the node's local +Y, so aim the field by rotating it.
 * The Wind presets are local wind (`affectsWind`): foliage bends to them and Scene-wind particles ride them.
 */
export type ForceFieldPreset = Preset<ForceFieldOptions>;

const BASE: ForceFieldOptions = { kind: 'directional', shape: 'sphere', strength: 5, falloff: 0.5, frequency: 0.5, affectsWind: false };

export const FORCE_FIELD_PRESETS: ForceFieldPreset[] = definePresets(BASE, [
    ['updraft', 'Updraft', 'Lifts particles along the node’s +Y, gravity and all — chimneys, vents, thermals.',
        { strength: 14, falloff: 0.4 }],
    ['windTunnel', 'Wind Tunnel', 'A hard-edged box of fast, steady wind.',
        { shape: 'box', strength: 10, falloff: 0.15 }],
    ['sceneBreeze', 'Scene Breeze', 'A gentle drift everywhere for smoke, dust and snow. It also slows their rise and fall, so keep it light.',
        { shape: 'global', strength: 1, falloff: 0 }],
    ['explosion', 'Explosion Push', 'Throws particles outward from the centre.',
        { kind: 'radial', strength: -40, falloff: 0.8 }],
    ['attractor', 'Attractor', 'Pulls particles toward the centre — magic, black holes. They overshoot and swing through it; add a Drag field to let them settle.',
        { kind: 'radial', strength: 15, falloff: 0.6 }],
    ['vortex', 'Vortex', 'Swirls particles around the node’s +Y axis. A swirl alone flings them outward; pair it with an Attractor for a whirlpool.',
        { kind: 'vortex', strength: 5, falloff: 0.5 }],
    ['turbulence', 'Turbulent Air', 'A field of curl-noise eddies — fire, heat shimmer, embers. The eddies stay put; particles drift through them.',
        { kind: 'turbulence', strength: 6, frequency: 0.6 }],
    ['gentleTurbulence', 'Gentle Turbulence', 'Slow, broad eddies over the whole scene.',
        { kind: 'turbulence', shape: 'global', strength: 2, falloff: 0, frequency: 0.25 }],
    ['drag', 'Thick Drag', 'Slows everything inside it — underwater, syrup; falling particles drift down slowly.',
        { kind: 'drag', strength: 3, falloff: 0.3 }],
    // Local wind: these move the AIR, so the foliage under them bends too. Strength is air speed (m/s).
    ['gustCorridor', 'Wind: Gust Corridor', 'A box of steady wind along +Y — a valley funnel, a gap between houses. Lay it on its side to blow across the ground.',
        { shape: 'box', strength: 9, falloff: 0.35, affectsWind: true }],
    ['whirlwind', 'Wind: Whirlwind', 'Air spinning round +Y: the grass swirls in a ring, still at the eye.',
        { kind: 'vortex', strength: 8, falloff: 0.6, affectsWind: true }],
    ['windBlast', 'Wind: Blast', 'Air thrown outward from the centre — a shockwave flattening a meadow. Animate the strength for a one-shot.',
        { kind: 'radial', strength: -12, falloff: 0.7, affectsWind: true }],
    ['windEddies', 'Wind: Eddies', 'Swirling, wandering patches of air carried along with the wind.',
        { kind: 'turbulence', strength: 4, frequency: 0.15, falloff: 0.5, affectsWind: true }],
    ['windShelter', 'Wind: Shelter', 'Blocks most of the wind inside — a courtyard, the lee of a cliff, a clearing in the woods.',
        { kind: 'drag', shape: 'box', strength: 0.85, falloff: 0.3, affectsWind: true }],
]);
