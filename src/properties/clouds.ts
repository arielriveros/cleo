// The volumetric clouds' and the exposure volume's declared properties (see declare.ts).

import { Color, Vec3 } from '../core/scripting/fieldTypes';
import { Choice } from '../core/properties/types';
import { VolumetricCloudsNode } from '../core/scene/nodes/volumetricCloudsNode';
import { ExposureVolumeNode, MIN_EXPOSURE_VOLUME_SIZE } from '../core/scene/nodes/exposureVolumeNode';
import { declareProperties, numberChoiceAccess } from './declare';

const whole = (v: number) => v.toFixed(0);
const fixed = (digits: number) => (v: number) => v.toFixed(digits);
const cloudTypeName = (t: number) => (t < 0.25 ? 'Stratus' : t < 0.5 ? 'Stratocumulus' : t < 0.8 ? 'Cumulus' : 'Cumulonimbus');
const ownWind = (n: VolumetricCloudsNode) => !(n.useSceneWind && !!n.scene?.wind);

declareProperties(VolumetricCloudsNode, 'Volumetric Clouds', [
    { title: '', props: [
        { key: 'enabled', type: Boolean },
        { key: 'opacity', type: Number, min: 0, max: 1, step: 0.01 },
    ] },
    { title: 'Shape', props: [
        { key: 'coverage', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'density', type: Number, min: 0, max: 4, step: 0.01 },
        { key: 'cloudType', label: 'Cloud Type', type: Number, min: 0, max: 1, step: 0.01, readout: cloudTypeName },
        { key: 'baseAltitude', type: Number, min: 0, max: 5000, step: 10, readout: whole },
        { key: 'thickness', type: Number, min: 50, max: 3000, step: 10, readout: whole },
        { key: 'baseScale', label: 'Base Noise Scale', type: Number, min: 0.00005, max: 0.002, step: 0.00005, readout: fixed(5) },
        { key: 'detailScale', label: 'Detail Noise Scale', type: Number, min: 0.0005, max: 0.01, step: 0.0005, readout: fixed(4) },
        { key: 'detailStrength', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'curlStrength', label: 'Curl / Turbulence', type: Number, min: 0, max: 3, step: 0.01 },
        { key: 'anvilBias', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'hazeDistance', type: Number, min: 0, max: 100000, step: 500, readout: whole },
    ] },
    { title: 'Lighting', props: [
        { key: 'useSceneSun', label: 'Use Scene Directional Light', type: Boolean },
        { key: 'sunDirection', label: 'Sun Direction', type: Vec3, step: 0.05, when: n => !n.useSceneSun },
        { key: 'sunColor', label: 'Sun Color', type: Color, when: n => !n.useSceneSun },
        { key: 'sunIntensity', type: Number, min: 0, max: 30, step: 0.1 },
        { key: 'useSkyAmbient', label: 'Ambient from Sky Light', type: Boolean },
        { key: 'ambientColor', label: 'Ambient (Sky) Color', type: Color },
        { key: 'ambientIntensity', type: Number, min: 0, max: 5, step: 0.05 },
        { key: 'groundColor', label: 'Ground Albedo', type: Color },
        { key: 'sunsetColor', label: 'Sunset/Sunrise Color', type: Color },
        { key: 'absorption', label: 'Extinction', type: Number, min: 0, max: 4, step: 0.01 },
        { key: 'albedo', type: Number, min: 0.5, max: 1, step: 0.005, readout: fixed(3) },
        { key: 'phaseG', label: 'Forward Scatter (Phase g)', type: Number, min: 0, max: 0.99, step: 0.01 },
        { key: 'phaseBackG', label: 'Back Scatter g', type: Number, min: -0.99, max: 0, step: 0.01 },
        { key: 'phaseBackWeight', label: 'Back Scatter Weight', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'silverIntensity', label: 'Silver Lining', type: Number, min: 0, max: 2, step: 0.01 },
        { key: 'silverSpread', type: Number, min: 0.01, max: 0.5, step: 0.01 },
        { key: 'powderStrength', label: 'Powder (dark edges)', type: Number, min: 0, max: 1, step: 0.01 },
    ] },
    { title: 'Multiple Scattering', props: [
        { key: 'msOctaves', label: 'Octaves', type: Number, min: 1, max: 4, step: 1, readout: whole },
        { key: 'msScatter', label: 'Scatter (a)', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'msExtinction', label: 'Extinction (b)', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'msEccentricity', label: 'Eccentricity (c)', type: Number, min: 0, max: 1, step: 0.01 },
    ] },
    { title: 'Animation', props: [
        { key: 'useSceneWind', label: 'Follow Scene Wind', type: Boolean },
        { key: 'windDirection', label: 'Wind Direction', type: Vec3, step: 0.05, when: ownWind },
        { key: 'windSpeed', type: Number, min: 0, max: 80, step: 0.5 },
        { key: 'detailWindFactor', type: Number, min: 0, max: 5, step: 0.05 },
    ] },
    { title: 'Sky Bake', props: [
        { key: 'bakeIntoSky', label: 'Bake into Sky in Play', type: Boolean },
        { key: 'previewBake', label: 'Preview Baked in Editor', type: Boolean, when: n => n.bakeIntoSky },
        { key: 'autoRebake', label: 'Re-bake When the Sun Moves', type: Boolean, when: n => n.bakeIntoSky },
        { key: 'bakeResolution', type: Choice(['256', '512', '1024']), when: n => n.bakeIntoSky, ...numberChoiceAccess<VolumetricCloudsNode>('bakeResolution') },
    ] },
    { title: 'Quality', props: [
        { key: 'resolutionScale', type: Number, min: 0.25, max: 1, step: 0.05, readout: v => `${Math.round(v * 100)}%` },
        { key: 'steps', label: 'March Steps', type: Number, min: 16, max: 192, step: 1, readout: whole },
        { key: 'lightSteps', type: Number, min: 2, max: 12, step: 1, readout: whole },
        { key: 'maxDistance', type: Number, min: 1000, max: 120000, step: 500, readout: whole },
        { key: 'jitter', label: 'Jitter (reduce banding)', type: Boolean },
        { key: 'temporalUpscale', label: 'Temporal Upscale (1/16 rays per frame)', type: Boolean },
    ] },
], 'environment');

declareProperties(ExposureVolumeNode, 'Exposure Volume', [
    { title: '', props: [
        { key: 'enabled', type: Boolean, divider: true },
        { key: 'size', type: Vec3, min: MIN_EXPOSURE_VOLUME_SIZE, step: 0.5, divider: true },
        { key: 'blendDistance', label: 'Blend distance', type: Number, min: 0, step: 0.1, divider: true },
        { key: 'priority', type: Number, step: 1 },
    ] },
], 'environment');
