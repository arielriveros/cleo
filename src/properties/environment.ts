// The lighting and environment nodes' declared properties (see declare.ts).

import { Color, Vec3 } from '../core/scripting/fieldTypes';
import { Choice } from '../core/properties/types';
import { VolumetricFogNode, MIN_FOG_VOLUME_SIZE } from '../core/scene/nodes/volumetricFogNode';
import { LightNode } from '../core/scene/nodes/lightNode';
import { SkyLightNode } from '../core/scene/nodes/skyLightNode';
import { WindNode } from '../core/scene/nodes/windNode';
import { OcclusionVolumeNode, type OcclusionVolumeCull } from '../core/scene/nodes/occlusionVolumeNode';
import { AreaLight, DirectionalLight, Spotlight } from '../graphics/lighting';
import { declareProperties } from './declare';

const directional = (n: LightNode) => n.light instanceof DirectionalLight;
const area = (n: LightNode) => n.light instanceof AreaLight;
const spot = (n: LightNode) => n.light instanceof Spotlight;

declareProperties(LightNode, 'Light', [
    { title: 'Emission', props: [
        { key: 'light.color', label: 'Color', type: Color },
        { key: 'light.intensity', type: Number, min: 0, step: n => (directional(n) ? 1000 : 100),
          label: n => (directional(n) ? 'Intensity (lx)' : 'Intensity (lm)'), divider: true },
        { key: 'light.range', label: 'Range (m)', type: Number, min: 0.01, step: 0.5, when: n => !directional(n) },
        { key: 'light.sourceRadius', label: 'Source Radius (m)', type: Number, min: 0, step: 0.01, when: n => !directional(n) && !area(n) },
        { key: 'light.flickerAmount', label: 'Flicker', type: Number, min: 0, max: 1, step: 0.01, when: n => !directional(n) },
        { key: 'light.flickerSpeed', label: 'Flicker Speed', type: Number, min: 0, step: 0.5,
          when: n => !directional(n) && (n.light as any).flickerAmount > 0 },
    ] },
    { title: 'Shadows', props: [{ key: 'castShadows', label: 'Cast Shadows', type: Boolean }] },
    { title: 'Baking', props: [{ key: 'bake', type: Boolean }] },
    { title: 'Cone', when: spot, props: [
        { key: 'light.cutOff', label: 'Inner Angle', type: Number, min: 0, max: 80, step: 0.5 },
        { key: 'light.outerCutOff', label: 'Outer Angle', type: Number, min: 0, max: 80, step: 0.5 },
    ] },
    { title: 'Emitter', when: area, props: [
        { key: 'light.shape', label: 'Shape', type: Choice(['rect', 'disk'], ['Rectangle', 'Disk']) },
        { key: 'light.width', type: Number, min: 0.01, step: 0.05,
          label: n => ((n.light as AreaLight).shape === 'disk' ? 'Diameter (m)' : 'Width (m)') },
        { key: 'light.height', label: 'Height (m)', type: Number, min: 0.01, step: 0.05, when: n => (n.light as AreaLight).shape === 'rect' },
        { key: 'light.twoSided', label: 'Two-sided', type: Boolean },
    ] },
    { title: 'Source', when: directional, props: [
        { key: 'light.angularRadius', label: 'Angular Radius', type: Number, min: 0, max: 0.1, step: 0.001 },
    ] },
], 'light');

declareProperties(VolumetricFogNode, 'Volumetric Fog', [
    { title: '', props: [
        { key: 'enabled', type: Boolean, divider: true },
        { key: 'size', type: Vec3, min: MIN_FOG_VOLUME_SIZE, step: 0.5 },
        { key: 'blendDistance', type: Number, min: 0, step: 0.5 },
        { key: 'priority', type: Number, step: 1, divider: true },
        { key: 'density', type: Number, min: 0, step: 0.005 },
        { key: 'albedo', type: Color },
        { key: 'anisotropy', type: Number, min: -0.9, max: 0.9, step: 0.01 },
        { key: 'heightFalloff', type: Number, min: 0, step: 0.05, divider: true },
        { key: 'noiseStrength', label: 'Noise', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'noiseScale', type: Number, min: 0.05, step: 0.5 },
        { key: 'windVelocity', label: 'Wind', type: Vec3, step: 0.1, divider: true },
        { key: 'emissiveColor', label: 'Emissive Color', type: Color },
        { key: 'emissiveIntensity', label: 'Emissive (nits)', type: Number, min: 0, step: 1, divider: true },
        { key: 'sunScattering', type: Number, min: 0, step: 0.1 },
        { key: 'localLightScattering', label: 'Light Scattering', type: Number, min: 0, step: 0.1 },
        { key: 'ambientScattering', type: Number, min: 0, step: 0.1 },
    ] },
], 'environment');

const cloudsDrawn = (n: SkyLightNode) => !!n.scene?.volumetricClouds?.enabled;

declareProperties(SkyLightNode, 'Sky Light', [
    { title: '', props: [
        { key: 'intensity', type: Number, min: 0, max: 4, step: 0.05 },
        { key: 'tint', type: Color },
        { key: 'ambient', type: Number, min: 0, max: 2, step: 0.05 },
        { key: 'nightAmbient', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'cloudResponse', type: Number, min: 0, max: 1, step: 0.05, divider: true },
        { key: 'cloudShadows', type: Boolean, when: cloudsDrawn },
        { key: 'cloudShadowStrength', label: 'Shadow Strength', type: Number, min: 0, max: 1, step: 0.05,
          when: n => cloudsDrawn(n) && n.cloudShadows },
    ] },
], 'environment');

declareProperties(WindNode, 'Wind', [
    { title: '', props: [
        { key: 'direction', type: Number, min: 0, max: 360, step: 1 },
        { key: 'strength', type: Number, min: 0, max: 2, step: 0.05 },
        { key: 'gustScale', label: 'Gust size', type: Number, min: 2, max: 80, step: 1 },
        { key: 'gustSpeed', label: 'Gust speed', type: Number, min: 0, max: 20, step: 0.5 },
        { key: 'gustiness', type: Number, min: 0, max: 1, step: 0.05 },
        { key: 'veer', type: Number, min: 0, max: 60, step: 1 },
        { key: 'fadeStart', label: 'Fade start', type: Number, min: 5, max: 200, step: 1 },
        { key: 'fadeEnd', label: 'Fade end', type: Number, min: 6, max: 250, step: 1 },
    ] },
], 'environment');

const CULL: [keyof OcclusionVolumeCull, string][] = [
    ['models', 'Models'], ['sprites', 'Sprites'], ['particles', 'Particles'], ['lights', 'Lights'],
    ['decals', 'Decals'], ['fluids', 'Fluids'], ['shadows', 'Shadows'],
];

declareProperties(OcclusionVolumeNode, 'Occlusion Volume', [
    { title: '', props: [
        { key: 'enabled', type: Boolean, divider: true },
        { key: 'size', type: Vec3, min: 0, step: 0.25 },
    ] },
    { title: 'Occlude', props: CULL.map(([key, label]) => ({
        key: `cull.${key}`, label, type: Boolean,
        get: (n: OcclusionVolumeNode) => n.cull[key],
        set: (n: OcclusionVolumeNode, on: unknown) => n.setCull(key, !!on),
    })) },
]);
