import type { VolumetricCloudsOptions } from "./volumetricCloudsNode";
import type { Preset } from "../../presets";

/**
 * One-click weather / time-of-day looks for VolumetricCloudsNode. A preset sets the shape, lighting
 * and animation fields only — never quality (steps, resolution, temporal), enabled, opacity or
 * useSceneSun, which stay the user's choice. sunDirection/sunColor only take effect when the node
 * overrides the scene sun.
 */
export type VolumetricCloudsPreset = Preset<VolumetricCloudsOptions>;

// Every preset is spread over this, so applying one never leaves fields from the previous preset behind.
const BASE: VolumetricCloudsOptions = {
    coverage: 0.5, density: 1.0, cloudType: 0.5, baseAltitude: 800, thickness: 700,
    baseScale: 0.0004, detailScale: 0.003, detailStrength: 0.35, curlStrength: 0.4, anvilBias: 0.0,
    sunDirection: [-0.5, -0.8, -0.35], sunColor: [1.0, 0.95, 0.85], sunIntensity: 10.0,
    ambientColor: [0.55, 0.65, 0.8], ambientIntensity: 1.0, groundColor: [0.4, 0.4, 0.42],
    sunsetColor: [1.0, 0.38, 0.16],
    phaseG: 0.5, silverIntensity: 0.6, silverSpread: 0.08, powderStrength: 0.25, absorption: 1.0,
    albedo: 0.98, phaseBackG: -0.25, phaseBackWeight: 0.2,
    msOctaves: 3, msScatter: 0.5, msExtinction: 0.5, msEccentricity: 0.5, hazeDistance: 35000,
    windDirection: [1.0, 0.0, 0.2], windSpeed: 12.0, detailWindFactor: 2.0,
};

const preset = (id: string, label: string, description: string, options: VolumetricCloudsOptions): VolumetricCloudsPreset =>
    ({ id, label, description, options: { ...BASE, ...options } });

export const VOLUMETRIC_CLOUDS_PRESETS: VolumetricCloudsPreset[] = [
    preset('clear', 'Clear Sky', 'Almost cloudless — a few small puffs in a bright blue sky.', {
        coverage: 0.08, cloudType: 0.6, baseAltitude: 1000, thickness: 450, hazeDistance: 50000,
        ambientColor: [0.5, 0.65, 0.9], ambientIntensity: 1.15, silverIntensity: 0.8, windSpeed: 8,
    }),
    preset('sunny', 'Sunny', 'Scattered fair-weather cumulus with bright silver edges.', {
        coverage: 0.3, cloudType: 0.65, baseAltitude: 900, thickness: 600,
        sunIntensity: 12, ambientColor: [0.52, 0.66, 0.88], ambientIntensity: 1.1,
        silverIntensity: 0.8, powderStrength: 0.3, windSpeed: 10, hazeDistance: 45000,
    }),
    preset('partlyCloudy', 'Partly Cloudy', 'A mix of sun and medium cumulus.', {
        coverage: 0.5, cloudType: 0.6, thickness: 800, detailStrength: 0.4,
    }),
    preset('cirrus', 'Cirrus (High Wisps)', 'Thin, high, wind-streaked ice clouds.', {
        coverage: 0.35, density: 0.4, cloudType: 0.05, baseAltitude: 4000, thickness: 200,
        baseScale: 0.00025, detailScale: 0.004, detailStrength: 0.7, curlStrength: 1.6,
        ambientIntensity: 1.2, phaseG: 0.6, silverIntensity: 1.0, silverSpread: 0.12, powderStrength: 0.05,
        absorption: 0.6, albedo: 0.99, msOctaves: 2, phaseBackWeight: 0.1, hazeDistance: 60000,
        windSpeed: 30, detailWindFactor: 3.0,
    }),
    preset('altocumulus', 'Altocumulus (Mackerel)', 'Mid-level rippled cloudlets in rows.', {
        coverage: 0.45, cloudType: 0.3, baseAltitude: 2500, thickness: 300,
        baseScale: 0.0009, detailScale: 0.006, detailStrength: 0.5, curlStrength: 0.6,
        silverIntensity: 0.8, windSpeed: 15,
    }),
    preset('overcast', 'Overcast', 'A flat grey sheet covering the whole sky.', {
        coverage: 0.9, density: 1.4, cloudType: 0.1, baseAltitude: 700, thickness: 900,
        detailStrength: 0.25, curlStrength: 0.3,
        sunIntensity: 4, sunColor: [0.92, 0.92, 0.92], ambientColor: [0.62, 0.64, 0.68], ambientIntensity: 0.9,
        groundColor: [0.38, 0.38, 0.4], phaseG: 0.35, silverIntensity: 0.1, powderStrength: 0.15,
        absorption: 1.3, msOctaves: 4, msScatter: 0.6, msExtinction: 0.6, phaseBackWeight: 0.3,
        hazeDistance: 25000, windSpeed: 8,
    }),
    preset('rainy', 'Rainy', 'Low, heavy, dark stratus — rain-bearing cloud.', {
        coverage: 0.95, density: 2.2, cloudType: 0.2, baseAltitude: 400, thickness: 1200,
        detailStrength: 0.3, curlStrength: 0.5,
        sunIntensity: 2, sunColor: [0.8, 0.82, 0.86], ambientColor: [0.32, 0.36, 0.42], ambientIntensity: 0.7,
        groundColor: [0.22, 0.23, 0.25], phaseG: 0.3, silverIntensity: 0.05, powderStrength: 0.35,
        absorption: 2.0, albedo: 0.95, msOctaves: 4, phaseBackWeight: 0.3, hazeDistance: 18000, windDirection: [1.0, 0.0, 0.5], windSpeed: 18, detailWindFactor: 2.5,
    }),
    preset('drizzle', 'Drizzle / Low Mist', 'A low, soft, misty layer hugging the hills.', {
        coverage: 0.85, density: 1.2, cloudType: 0.05, baseAltitude: 250, thickness: 400,
        detailStrength: 0.45, curlStrength: 0.8,
        sunIntensity: 3, sunColor: [0.88, 0.9, 0.92], ambientColor: [0.5, 0.54, 0.58], ambientIntensity: 0.85,
        groundColor: [0.32, 0.33, 0.34], phaseG: 0.3, silverIntensity: 0.1, powderStrength: 0.15,
        absorption: 1.2, msOctaves: 4, phaseBackWeight: 0.3, hazeDistance: 12000, windSpeed: 6,
    }),
    preset('stormy', 'Thunderstorm', 'Dark towering storm cells with anvil tops.', {
        coverage: 0.8, density: 2.5, cloudType: 0.95, baseAltitude: 600, thickness: 2600,
        detailStrength: 0.45, curlStrength: 0.9, anvilBias: 0.7,
        sunIntensity: 3, sunColor: [0.85, 0.85, 0.9], ambientColor: [0.26, 0.29, 0.36], ambientIntensity: 0.6,
        groundColor: [0.18, 0.19, 0.21], phaseG: 0.4, silverIntensity: 0.3, powderStrength: 0.4,
        absorption: 2.5, albedo: 0.95, msOctaves: 4, hazeDistance: 30000, windDirection: [1.0, 0.0, -0.3], windSpeed: 25, detailWindFactor: 3.0,
    }),
    preset('cumulonimbus', 'Towering Cumulonimbus', 'Isolated giant thunderheads in an otherwise clear sky.', {
        coverage: 0.35, density: 1.6, cloudType: 1.0, baseAltitude: 700, thickness: 2800,
        detailStrength: 0.4, curlStrength: 0.6, anvilBias: 0.8,
        sunIntensity: 12, silverIntensity: 0.9, powderStrength: 0.35, absorption: 1.4, msOctaves: 4,
        hazeDistance: 50000, windSpeed: 10,
    }),
    preset('sunrise', 'Sunrise', 'Cool pink-gold morning light under a low sun.', {
        coverage: 0.4, cloudType: 0.5, thickness: 650,
        sunDirection: [-0.85, -0.12, -0.5], sunColor: [1.0, 0.75, 0.55], sunIntensity: 8,
        ambientColor: [0.62, 0.55, 0.72], ambientIntensity: 0.75, groundColor: [0.42, 0.36, 0.38],
        sunsetColor: [1.0, 0.55, 0.45], phaseG: 0.7, silverIntensity: 1.2, silverSpread: 0.12,
        powderStrength: 0.25, windSpeed: 8,
    }),
    preset('sunset', 'Sunset', 'Warm orange glow lighting the cloud bases from below the horizon.', {
        coverage: 0.45, cloudType: 0.45, thickness: 700,
        sunDirection: [0.85, -0.1, 0.5], sunColor: [1.0, 0.55, 0.28], sunIntensity: 9,
        ambientColor: [0.55, 0.4, 0.55], ambientIntensity: 0.7, groundColor: [0.45, 0.3, 0.25],
        sunsetColor: [1.0, 0.32, 0.1], phaseG: 0.75, silverIntensity: 1.5, silverSpread: 0.14,
        powderStrength: 0.25, absorption: 1.1, windSpeed: 8,
    }),
    preset('dusk', 'Dusk (Blue Hour)', 'Sun just gone — cool, dim twilight.', {
        coverage: 0.4, cloudType: 0.45,
        sunDirection: [0.9, 0.05, 0.4], sunColor: [0.75, 0.55, 0.65], sunIntensity: 1.5,
        ambientColor: [0.24, 0.3, 0.52], ambientIntensity: 0.5, groundColor: [0.16, 0.17, 0.24],
        sunsetColor: [0.8, 0.35, 0.4], phaseG: 0.6, silverIntensity: 0.5, powderStrength: 0.2, windSpeed: 6,
    }),
    preset('night', 'Night (Moonlit)', 'Dark clouds faintly lit by a cool moon. With a Sky Atmosphere the moon already lights any preset after sunset; this one is for a manual sun or a sky without one.', {
        coverage: 0.35, cloudType: 0.5,
        sunDirection: [-0.3, -0.7, 0.6], sunColor: [0.65, 0.75, 1.0], sunIntensity: 1.0,
        ambientColor: [0.06, 0.08, 0.16], ambientIntensity: 0.2, groundColor: [0.04, 0.04, 0.06],
        sunsetColor: [0.3, 0.3, 0.45], phaseG: 0.6, silverIntensity: 0.7, powderStrength: 0.15, windSpeed: 6,
    }),
    preset('windy', 'Windy', 'Broken, fast-moving clouds with ragged edges.', {
        coverage: 0.5, cloudType: 0.55, thickness: 650,
        detailStrength: 0.5, curlStrength: 1.2,
        windDirection: [1.0, 0.0, 0.35], windSpeed: 60, detailWindFactor: 3.5,
    }),
    preset('haze', 'Hazy', 'Soft, low-contrast veil of cloud.', {
        coverage: 0.7, density: 0.6, cloudType: 0.15, baseAltitude: 1200, thickness: 900,
        detailStrength: 0.15, curlStrength: 0.3,
        sunIntensity: 7, ambientColor: [0.68, 0.7, 0.76], ambientIntensity: 1.1, groundColor: [0.5, 0.5, 0.5],
        phaseG: 0.4, silverIntensity: 0.3, silverSpread: 0.2, powderStrength: 0.1, absorption: 0.7,
        msOctaves: 4, hazeDistance: 20000, windSpeed: 5,
    }),
];
