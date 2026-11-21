// The sound's, the particle system's, the force field's and the cloth's declared properties (see declare.ts).

import { ColorAlpha, Vec3 } from '../core/scripting/fieldTypes';
import { Choice, Integer } from '../core/properties/types';
import { SoundNode } from '../core/scene/nodes/soundNode';
import { ParticleSystemNode } from '../core/scene/nodes/particleSystemNode';
import { ForceFieldNode } from '../core/scene/nodes/forceFieldNode';
import { ClothNode, type ClothOptions } from '../core/scene/nodes/clothNode';
import { declareProperties, type PropertyDeclaration } from './declare';

// Documented in Audio › Sound nodes, whose rows are these fields' tooltips. The Falloff card shows its section.
declareProperties(SoundNode, 'Sound', [
    { title: '', props: [
        { key: 'mode', type: Choice(['spatial', 'ambient'], ['Spatial', 'Ambient']), divider: true },
        { key: 'volume', type: Number, min: 0, max: 1, step: 0.01, divider: true },
        { key: 'loopMode', label: 'Loop', type: Choice(['inherit', 'on', 'off'], ['Sample', 'On', 'Off']), divider: true },
        { key: 'playOnStart', label: 'Play on start', type: Boolean },
    ] },
    { title: 'Falloff', when: n => n.mode === 'spatial', props: [
        { key: 'distanceModel', label: 'Distance model', type: Choice(['inverse', 'linear', 'exponential'], ['Inverse', 'Linear', 'Exponential']), divider: true },
        { key: 'refDistance', label: 'Reference', type: Number, min: 0.01, step: 0.1, divider: true },
        { key: 'maxDistance', label: 'Max', type: Number, min: 0.02, step: 1, divider: true },
        { key: 'rolloffFactor', label: 'Rolloff', type: Number, min: 0, max: 10, step: 0.1 },
    ] },
], { docs: 'editor/audio', section: 'sound-nodes' });

// Documented with the particle editor ("In a scene"), next to the asset this node plays.
declareProperties(ParticleSystemNode, 'Particle System', [
    { title: '', props: [
        { key: 'playOnStart', label: 'Play on start', type: Boolean, divider: true },
        { key: 'simulationSpeed', label: 'Simulation speed', type: Number, min: 0, max: 3, step: 0.05, divider: true },
        { key: 'spawnRateScale', label: 'Spawn rate', type: Number, min: 0, max: 4, step: 0.05, divider: true },
        { key: 'cullingMode', label: 'Off screen', type: Choice(['auto', 'pause', 'simulate'], ['Auto', 'Pause', 'Keep simulating']), divider: true },
        { key: 'lodEnabled', label: 'Distance LOD', type: Boolean, divider: true },
        { key: 'exposureWeight', label: 'Exposure weight', type: Number, min: 0, max: 1, step: 0.05, divider: true },
        { key: 'fogGlow', label: 'Fog Glow (lm)', type: Number, min: 0, step: 50 },
        // After the card's Follow Light rows.
        { key: 'tint', type: ColorAlpha },
    ] },
], { docs: 'editor/particles', section: 'in-a-scene' });

const shaped = (n: ForceFieldNode) => n.shape !== 'global';
// Moving the air, a drag field's strength is the share of the wind it blocks: 0 to 1.
const blocksWind = (n: ForceFieldNode) => n.affectsWind && n.kind === 'drag';

declareProperties(ForceFieldNode, 'Force Field', [
    { title: '', props: [
        { key: 'enabled', type: Boolean, divider: true },
        { key: 'affectsWind', label: 'Affects wind', type: Boolean, divider: true },
        { key: 'kind', label: 'Force', type: Choice(['directional', 'radial', 'vortex', 'turbulence', 'drag'], ['Wind', 'Radial', 'Vortex', 'Turbulence', 'Drag']), divider: true },
        { key: 'strength', type: Number, step: 0.5, divider: true, when: n => !blocksWind(n) },
        { key: 'strength.share', label: 'Strength', type: Number, min: 0, max: 1, step: 0.01, divider: true, when: blocksWind,
          get: n => Math.min(1, Math.max(0, n.strength)), set: (n, v) => { n.strength = Number(v); } },
        { key: 'frequency', type: Number, min: 0.001, step: 0.05, divider: true, when: n => n.kind === 'turbulence' },
        { key: 'shape', type: Choice(['global', 'sphere', 'box'], ['Global', 'Sphere', 'Box']), divider: true },
        { key: 'radius', type: Number, min: 0.01, step: 0.25, divider: true, when: n => n.shape === 'sphere' },
        { key: 'extents', label: 'Half extents', type: Vec3, min: 0, step: 0.1, divider: true, when: n => n.shape === 'box' },
        { key: 'falloff', type: Number, min: 0, max: 1, step: 0.01, when: shaped },
    ] },
]);

/** A cloth option: the cloth is set through setOptions, which rebuilds what the change needs. */
const option = <K extends keyof ClothOptions>(key: K, decl: Omit<PropertyDeclaration<ClothNode>, 'key' | 'get' | 'set'>): PropertyDeclaration<ClothNode> => ({
    key: `options.${String(key)}`, ...decl,
    get: n => n.options[key],
    set: (n, v) => n.setOptions({ [key]: v } as ClothOptions),
});

declareProperties(ClothNode, 'Cloth', [
    { title: '', props: [
        option('enabled', { type: Boolean, divider: true }),
        option('width', { type: Number, min: 0.05, step: 0.05, divider: true }),
        option('height', { type: Number, min: 0.05, step: 0.05, divider: true }),
        option('columns', { type: Integer, min: 2, max: 64, step: 1, divider: true }),
        option('rows', { type: Integer, min: 2, max: 64, step: 1, divider: true }),
        option('pinEdge', { label: 'Held Edge', type: Choice(['top', 'left', 'none'], ['Top', 'Left', 'None']), divider: true }),
        option('bone', { label: 'Ride On', type: Choice(['', 'chest', 'spine', 'neck', 'hips'], ['This node', 'Chest', 'Spine', 'Neck', 'Hips']), divider: true }),
        option('stiffness', { type: Number, min: 0, max: 1, step: 0.01, divider: true }),
        option('bend', { type: Number, min: 0, max: 1, step: 0.01, divider: true }),
        option('damping', { type: Number, min: 0, max: 1, step: 0.01, divider: true }),
        option('mass', { type: Number, min: 0.01, step: 0.1, divider: true }),
        option('thickness', { type: Number, min: 0, step: 0.01, divider: true }),
        option('windResponse', { label: 'Wind Response', type: Number, min: 0, max: 3, step: 0.05, divider: true }),
        option('collideWithOwner', { label: 'Collide With Character', type: Boolean }),
    ] },
]);
