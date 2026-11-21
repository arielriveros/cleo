// The sky's declared properties (see declare.ts): Sky Atmosphere.

import { Color, Vec3 } from '../core/scripting/fieldTypes';
import { Choice } from '../core/properties/types';
import { SkyAtmosphereNode } from '../core/scene/nodes/skyAtmosphereNode';
import { Texture } from '../graphics/texture';
import { REFERENCE_ILLUMINANCE } from '../graphics/lighting';
import { declareProperties, assetIdAccess, numberChoiceAccess } from './declare';

const night = (n: SkyAtmosphereNode) => n.nightEnabled;
const stars = (n: SkyAtmosphereNode) => n.nightEnabled && !n.nightSkyTexture;
const nightTexture = (n: SkyAtmosphereNode) => n.nightEnabled && !!n.nightSkyTexture;
const moon = (n: SkyAtmosphereNode) => n.nightEnabled && n.moonEnabled;
const fog = (n: SkyAtmosphereNode) => n.fogEnabled;
const rays = (n: SkyAtmosphereNode) => n.godRaysEnabled;
const phaseName = (p: number) => (p < 0.06 ? 'New' : p < 0.45 ? 'Crescent' : p < 0.55 ? 'Half' : p < 0.94 ? 'Gibbous' : 'Full');
const whole = (v: number) => v.toFixed(0);

/** The scene sun's lux, which a sky saved before lux kept its moonlight as a fraction of (the reference when it has none). */
export function sceneSunLux(node: SkyAtmosphereNode): number {
    for (const light of (node.scene as any)?.lights ?? []) {
        if (light.type === 'directional') return light.light.internalIntensity * REFERENCE_ILLUMINANCE;
    }
    return REFERENCE_ILLUMINANCE;
}

declareProperties(SkyAtmosphereNode, 'Sky Atmosphere', [
    { title: 'Sun', props: [
        { key: 'useSceneSun', label: 'Use Scene Directional Light', type: Boolean },
        { key: 'sunDirection', label: 'Sun Direction', type: Vec3, step: 0.05, when: n => !n.useSceneSun },
        { key: 'sunColor', label: 'Sun Color', type: Color },
        { key: 'physicalUnits', label: 'Physical Units', type: Boolean, when: n => n.useSceneSun },
        { key: 'sunIntensity', label: 'Sun Intensity', type: Number, min: 0, max: 40, step: 0.1, when: n => !(n.useSceneSun && n.physicalUnits) },
        { key: 'sunDiskSize', label: 'Sun Disk Size (deg)', type: Number, min: 0, max: 10, step: 0.1 },
    ] },
    { title: 'Atmosphere', props: [
        { key: 'rayleighScatter', type: Number, min: 0, max: 4, step: 0.01 },
        { key: 'rayleighHeight', type: Number, min: 1000, max: 16000, step: 100, readout: whole },
        { key: 'mieScatter', type: Number, min: 0, max: 10, step: 0.01 },
        { key: 'mieHeight', type: Number, min: 100, max: 4000, step: 50, readout: whole },
        { key: 'mieG', label: 'Mie Anisotropy (g)', type: Number, min: 0, max: 0.99, step: 0.01 },
        { key: 'exposure', type: Number, min: 0, max: 4, step: 0.05 },
        { key: 'groundColor', label: 'Ground Color', type: Color },
        { key: 'planetRadius', type: Number, min: 1000000, max: 10000000, step: 100000, readout: whole },
        { key: 'atmosphereRadius', type: Number, min: 1000000, max: 11000000, step: 100000, readout: whole },
    ] },
    { title: 'Night Sky', props: [
        { key: 'nightEnabled', label: 'Enable Night Sky', type: Boolean },
        { key: 'nightSkyTexture', label: 'Night Sky Texture', type: Texture, when: night, ...assetIdAccess<SkyAtmosphereNode>('texture', 'nightSkyTexture') },
        { key: 'nightSkyIntensity', label: 'Texture Intensity', type: Number, min: 0, max: 4, step: 0.01, when: nightTexture },
        { key: 'nightSkyRotation', label: 'Texture Rotation', type: Number, min: 0, max: 360, step: 1, readout: whole, when: nightTexture },
        { key: 'starIntensity', label: 'Star Brightness', type: Number, min: 0, max: 4, step: 0.01, when: stars },
        { key: 'starDensity', type: Number, min: 0, max: 1, step: 0.01, when: stars },
        { key: 'starColorVariance', label: 'Star Colour Variance', type: Number, min: 0, max: 1, step: 0.01, when: stars },
        { key: 'airglowColor', label: 'Airglow Color', type: Color, when: night },
        { key: 'airglowIntensity', label: 'Airglow', type: Number, min: 0, max: 4, step: 0.01, when: night },
    ] },
    { title: 'Moon', when: night, props: [
        { key: 'moonEnabled', label: 'Enable Moon', type: Boolean },
        { key: 'moonTexture', label: 'Moon Texture', type: Texture, when: moon, ...assetIdAccess<SkyAtmosphereNode>('texture', 'moonTexture') },
        { key: 'moonPhase', label: 'Phase', type: Number, min: 0, max: 1, step: 0.01, readout: phaseName, when: moon },
        { key: 'moonSize', label: 'Size (deg)', type: Number, min: 0.1, max: 15, step: 0.1, when: moon },
        { key: 'moonOffsetYaw', label: 'Offset Azimuth', type: Number, min: -180, max: 180, step: 1, readout: whole, when: moon },
        { key: 'moonOffsetPitch', label: 'Offset Elevation', type: Number, min: -60, max: 60, step: 1, readout: whole, when: moon },
        { key: 'moonColor', label: 'Moon Color', type: Color, when: moon },
        { key: 'moonIntensity', label: 'Moon Brightness', type: Number, min: 0, max: 4, step: 0.01, when: moon },
        { key: 'moonIlluminance', label: 'Moonlight (lux)', type: Number, min: 0, step: 0.1, when: moon,
          get: n => n.moonIlluminance ?? n.moonLux(sceneSunLux(n)),
          set: (n, v) => { n.moonIlluminance = Math.max(0, Number(v)); } },
    ] },
    { title: 'Quality', props: [
        { key: 'resolution', type: Choice(['64', '128', '256', '512']), ...numberChoiceAccess<SkyAtmosphereNode>('resolution') },
        { key: 'viewSteps', type: Number, min: 4, max: 64, step: 1, readout: whole },
        { key: 'lightSteps', type: Number, min: 2, max: 32, step: 1, readout: whole },
    ] },
    { title: 'Fog (aerial perspective)', props: [
        { key: 'fogEnabled', label: 'Enable Fog', type: Boolean },
        { key: 'fogDensity', label: 'Density', type: Number, min: 0, max: 0.05, step: 0.0001, when: fog },
        { key: 'fogStart', label: 'Start Distance', type: Number, min: 0, max: 2000, step: 5, readout: whole, when: fog },
        { key: 'fogMaxOpacity', label: 'Max Opacity', type: Number, min: 0, max: 1, step: 0.01, when: fog },
        { key: 'fogHeight', label: 'Height', type: Number, min: -500, max: 2000, step: 10, readout: whole, when: fog },
        { key: 'fogHeightFalloff', label: 'Height Falloff', type: Number, min: 0, max: 0.2, step: 0.0005, when: fog },
        { key: 'fogColor', label: 'Custom Color', type: Color, when: fog },
        { key: 'fogColorBlend', label: 'Custom Color Blend', type: Number, min: 0, max: 1, step: 0.01, when: fog },
    ] },
    { title: 'God Rays (volumetric light shafts)', props: [
        { key: 'godRaysEnabled', label: 'Enable God Rays', type: Boolean },
        { key: 'godRayExposure', label: 'Intensity', type: Number, min: 0, max: 2, step: 0.01, when: rays },
        { key: 'godRayDensity', label: 'Density', type: Number, min: 0, max: 1, step: 0.01, when: rays },
        { key: 'godRayAnisotropy', label: 'Anisotropy', type: Number, min: 0, max: 0.95, step: 0.01, when: rays },
        { key: 'godRayMaxDistance', label: 'Max Distance', type: Number, min: 5, max: 500, step: 5, readout: whole, when: rays },
        { key: 'godRaySamples', label: 'March Steps', type: Number, min: 8, max: 128, step: 1, readout: whole, when: rays },
        { key: 'godRayTint', label: 'Tint', type: Color, when: rays },
    ] },
], 'environment');
