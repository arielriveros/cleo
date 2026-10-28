import { Texture } from "../../../graphics/texture";
import type { Scene } from "../scene";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { SKY_ATMOSPHERE_PRESETS, type SkyAtmospherePreset } from "./skyAtmospherePresets";
import { applyPreset } from "../../presets";

/**
 * Nishita atmospheric scattering baked to a cubemap. Scene singleton.
 */

export interface SkyAtmosphereOptions {
    // Sun
    useSceneSun?: boolean;                      // true = take direction/color from the scene directional light
    sunDirection?: [number, number, number];    // override: direction TOWARD the sun (used when useSceneSun=false / no light)
    sunColor?: [number, number, number];
    sunIntensity?: number;
    // Atmosphere
    rayleighScatter?: number;   // multiplier on the Earth Rayleigh coefficients
    rayleighHeight?: number;    // Rayleigh scale height (m)
    mieScatter?: number;        // multiplier on the Mie coefficient
    mieHeight?: number;         // Mie scale height (m)
    mieG?: number;              // Mie anisotropy (forward scattering)
    planetRadius?: number;      // m
    atmosphereRadius?: number;  // m
    sunDiskSize?: number;       // angular radius of the sun disk (degrees)
    exposure?: number;
    groundColor?: [number, number, number]; // tint for below-horizon (downward) directions
    // Quality
    resolution?: number;        // cubemap face size
    viewSteps?: number;         // primary raymarch samples
    lightSteps?: number;        // secondary (toward-sun) samples
    // Fog (distance fog whose color is sampled from the atmosphere cubemap — aerial perspective)
    fogEnabled?: boolean;
    fogDensity?: number;        // exponential density (per world unit)
    fogStart?: number;          // distance before fog begins (world units)
    fogHeight?: number;         // world Y where fog is densest (height fog)
    fogHeightFalloff?: number;  // how quickly fog thins with altitude (0 = uniform, no height dependence)
    fogMaxOpacity?: number;     // 0..1 cap so distant geometry never fully disappears
    fogColor?: [number, number, number]; // custom tint, blended with the atmosphere color
    fogColorBlend?: number;     // 0 = pure atmosphere color, 1 = pure custom fogColor
    // God rays (volumetric light shafts from the scene directional light — a raymarched post pass
    // that tests the sun's shadow map along each view ray).
    godRaysEnabled?: boolean;
    godRaySamples?: number;      // raymarch steps per pixel (quality/cost)
    godRayDensity?: number;      // 0..1 — scattering density of the participating medium
    godRayExposure?: number;     // overall shaft intensity
    godRayTint?: [number, number, number]; // multiply tint on the shafts
    godRayAnisotropy?: number;   // 0..0.95 — Henyey-Greenstein g: higher = light hugs the sun direction
    godRayMaxDistance?: number;  // world units — how far from the camera the march extends
    // Night sky (stars, moon, airglow — baked into the same cubemap)
    nightEnabled?: boolean;       // stars, moon and airglow once the sun has set
    starIntensity?: number;       // brightness of the procedural stars
    starDensity?: number;         // 0..1 — how many stars
    starColorVariance?: number;   // 0..1 — spread of star colour temperatures
    nightSkyTexture?: string | null; // equirect texture id replacing the procedural stars (null = procedural)
    nightSkyIntensity?: number;   // multiplier on the custom night-sky texture
    nightSkyRotation?: number;    // degrees — spins the custom night sky about the vertical axis
    airglowColor?: [number, number, number]; // faint emission toward the horizon, so a moonless night is not black
    airglowIntensity?: number;    // multiplier on the airglow
    moonEnabled?: boolean;        // draw the moon and let it light the night
    moonTexture?: string | null;  // texture id for the moon disc (null = procedural)
    moonSize?: number;            // angular radius of the moon disc (degrees)
    moonPhase?: number;           // 0 = new moon .. 1 = full moon
    moonOffsetYaw?: number;       // degrees — moon azimuth away from the point opposite the sun
    moonOffsetPitch?: number;     // degrees — moon elevation away from the point opposite the sun
    moonColor?: [number, number, number]; // tint of the moon and its light
    moonIntensity?: number;       // brightness of the moon disc and the moonlit sky
    moonlightIntensity?: number;  // moonlight as a fraction of the sun light: the moon's key light, and the night sky's brightness
}

/**
 * The default moonlight ratio, at which the baked night sky keeps the brightness it was tuned at. The sky
 * scales with `moonlightIntensity / DEFAULT_MOONLIGHT_INTENSITY`: a real moon is about 2e-6 of the sun.
 */
export const DEFAULT_MOONLIGHT_INTENSITY = 0.08;

/**
 * Scene-wide physically-based sky. Holds only parameters; the runtime cubemap is NOT serialized. The
 * renderer bakes a Nishita single-scattering atmosphere into it whenever the directional light changes
 * direction. Mutually exclusive with SkyboxNode — the editor enforces one at a time.
 */
export class SkyAtmosphereNode extends Node {
    // Sun
    private _useSceneSun: boolean;
    private _sunDirection: [number, number, number];
    private _sunColor: [number, number, number];
    private _sunIntensity: number;
    // Atmosphere
    private _rayleighScatter: number;
    private _rayleighHeight: number;
    private _mieScatter: number;
    private _mieHeight: number;
    private _mieG: number;
    private _planetRadius: number;
    private _atmosphereRadius: number;
    private _sunDiskSize: number;
    private _exposure: number;
    private _groundColor: [number, number, number];
    // Quality
    private _resolution: number;
    private _viewSteps: number;
    private _lightSteps: number;
    // Fog (applied per-frame in a screen-space pass; changing these does NOT require a cubemap re-bake)
    private _fogEnabled: boolean;
    private _fogDensity: number;
    private _fogStart: number;
    private _fogHeight: number;
    private _fogHeightFalloff: number;
    private _fogMaxOpacity: number;
    private _fogColor: [number, number, number];
    private _fogColorBlend: number;
    // God rays (per-frame screen-space post pass; changing these does NOT require a cubemap re-bake)
    private _godRaysEnabled: boolean;
    private _godRaySamples: number;
    private _godRayDensity: number;
    private _godRayExposure: number;
    private _godRayTint: [number, number, number];
    private _godRayAnisotropy: number;
    private _godRayMaxDistance: number;
    // Night sky
    private _nightEnabled: boolean;
    private _starIntensity: number;
    private _starDensity: number;
    private _starColorVariance: number;
    private _nightSkyTexture: string | null;
    private _nightSkyIntensity: number;
    private _nightSkyRotation: number;
    private _airglowColor: [number, number, number];
    private _airglowIntensity: number;
    private _moonEnabled: boolean;
    private _moonTexture: string | null;
    private _moonSize: number;
    private _moonPhase: number;
    private _moonOffsetYaw: number;
    private _moonOffsetPitch: number;
    private _moonColor: [number, number, number];
    private _moonIntensity: number;
    private _moonlightIntensity: number;
    // Runtime bake state (not serialized)
    private _cubemap: Texture | null = null;
    private _cubemapResolution: number = 0;
    private _needsBake: boolean = true;
    private _lastSunDir: [number, number, number] = [0, -1, 0];

    constructor(name: string, options: SkyAtmosphereOptions = {}, id: string = uuidv4()) {
        super(name, 'skyAtmosphere', id);
        this._useSceneSun = options.useSceneSun ?? true;
        this._sunDirection = options.sunDirection ?? [0.0, 0.35, -0.94];
        this._sunColor = options.sunColor ?? [1.0, 1.0, 1.0];
        this._sunIntensity = options.sunIntensity ?? 22.0;

        this._rayleighScatter = options.rayleighScatter ?? 1.0;
        this._rayleighHeight = options.rayleighHeight ?? 8000.0;
        this._mieScatter = options.mieScatter ?? 1.0;
        this._mieHeight = options.mieHeight ?? 1200.0;
        this._mieG = options.mieG ?? 0.76;
        this._planetRadius = options.planetRadius ?? 6371000.0;
        this._atmosphereRadius = options.atmosphereRadius ?? 6471000.0;
        this._sunDiskSize = options.sunDiskSize ?? 1.5;
        this._exposure = options.exposure ?? 1.3;
        this._groundColor = options.groundColor ?? [0.25, 0.22, 0.2];

        this._resolution = options.resolution ?? 256;
        this._viewSteps = options.viewSteps ?? 16;
        this._lightSteps = options.lightSteps ?? 8;

        this._fogEnabled = options.fogEnabled ?? false; // opt-in: adding a sky shouldn't fog the scene
        this._fogDensity = options.fogDensity ?? 0.0008;
        this._fogStart = options.fogStart ?? 20.0;
        this._fogHeight = options.fogHeight ?? 0.0;
        this._fogHeightFalloff = options.fogHeightFalloff ?? 0.0;
        this._fogMaxOpacity = options.fogMaxOpacity ?? 0.7; // keep objects readable (never fully sky)
        this._fogColor = options.fogColor ?? [0.7, 0.8, 0.9];
        this._fogColorBlend = options.fogColorBlend ?? 0.0;

        this._godRaysEnabled = options.godRaysEnabled ?? false; // opt-in
        this._godRaySamples = options.godRaySamples ?? 64;
        this._godRayDensity = options.godRayDensity ?? 0.9;
        this._godRayExposure = options.godRayExposure ?? 0.3;
        this._godRayTint = options.godRayTint ?? [1.0, 1.0, 1.0];
        this._godRayAnisotropy = options.godRayAnisotropy ?? 0.6;
        this._godRayMaxDistance = options.godRayMaxDistance ?? 80;

        this._nightEnabled = options.nightEnabled ?? true;
        this._starIntensity = options.starIntensity ?? 1.0;
        this._starDensity = options.starDensity ?? 0.5;
        this._starColorVariance = options.starColorVariance ?? 0.6;
        this._nightSkyTexture = options.nightSkyTexture ?? null;
        this._nightSkyIntensity = options.nightSkyIntensity ?? 1.0;
        this._nightSkyRotation = options.nightSkyRotation ?? 0;
        this._airglowColor = options.airglowColor ?? [0.10, 0.13, 0.22];
        this._airglowIntensity = options.airglowIntensity ?? 1.0;
        this._moonEnabled = options.moonEnabled ?? true;
        this._moonTexture = options.moonTexture ?? null;
        this._moonSize = options.moonSize ?? 2.0;
        this._moonPhase = options.moonPhase ?? 1.0;
        this._moonOffsetYaw = options.moonOffsetYaw ?? 25;
        this._moonOffsetPitch = options.moonOffsetPitch ?? 15;
        this._moonColor = options.moonColor ?? [0.82, 0.88, 1.0];
        this._moonIntensity = options.moonIntensity ?? 1.0;
        this._moonlightIntensity = options.moonlightIntensity ?? DEFAULT_MOONLIGHT_INTENSITY;
    }

    // --- Sun ---
    public get useSceneSun(): boolean { return this._useSceneSun; }
    public set useSceneSun(v: boolean) { this._useSceneSun = v; this._needsBake = true; }
    public get sunDirection(): [number, number, number] { return this._sunDirection; }
    public set sunDirection(v: [number, number, number]) { this._sunDirection = v; this._needsBake = true; }
    public get sunColor(): [number, number, number] { return this._sunColor; }
    public set sunColor(v: [number, number, number]) { this._sunColor = v; this._needsBake = true; }
    public get sunIntensity(): number { return this._sunIntensity; }
    public set sunIntensity(v: number) { this._sunIntensity = Math.max(0, v); this._needsBake = true; }

    // --- Atmosphere ---
    public get rayleighScatter(): number { return this._rayleighScatter; }
    public set rayleighScatter(v: number) { this._rayleighScatter = Math.max(0, v); this._needsBake = true; }
    public get rayleighHeight(): number { return this._rayleighHeight; }
    public set rayleighHeight(v: number) { this._rayleighHeight = Math.max(1, v); this._needsBake = true; }
    public get mieScatter(): number { return this._mieScatter; }
    public set mieScatter(v: number) { this._mieScatter = Math.max(0, v); this._needsBake = true; }
    public get mieHeight(): number { return this._mieHeight; }
    public set mieHeight(v: number) { this._mieHeight = Math.max(1, v); this._needsBake = true; }
    public get mieG(): number { return this._mieG; }
    public set mieG(v: number) { this._mieG = Math.min(0.99, Math.max(-0.99, v)); this._needsBake = true; }
    public get planetRadius(): number { return this._planetRadius; }
    public set planetRadius(v: number) { this._planetRadius = Math.max(1, v); this._needsBake = true; }
    public get atmosphereRadius(): number { return this._atmosphereRadius; }
    public set atmosphereRadius(v: number) { this._atmosphereRadius = Math.max(1, v); this._needsBake = true; }
    public get sunDiskSize(): number { return this._sunDiskSize; }
    public set sunDiskSize(v: number) { this._sunDiskSize = Math.max(0, v); this._needsBake = true; }
    public get exposure(): number { return this._exposure; }
    public set exposure(v: number) { this._exposure = Math.max(0, v); this._needsBake = true; }
    public get groundColor(): [number, number, number] { return this._groundColor; }
    public set groundColor(v: [number, number, number]) { this._groundColor = v; this._needsBake = true; }

    // --- Quality ---
    public get resolution(): number { return this._resolution; }
    public set resolution(v: number) { const n = Math.min(1024, Math.max(16, Math.floor(v))); if (n !== this._resolution) { this._resolution = n; this._needsBake = true; } }
    public get viewSteps(): number { return this._viewSteps; }
    public set viewSteps(v: number) { this._viewSteps = Math.min(64, Math.max(4, Math.floor(v))); this._needsBake = true; }
    public get lightSteps(): number { return this._lightSteps; }
    public set lightSteps(v: number) { this._lightSteps = Math.min(32, Math.max(2, Math.floor(v))); this._needsBake = true; }

    // --- Fog (per-frame screen pass; setters do NOT flip needsBake — no cubemap re-bake needed) ---
    public get fogEnabled(): boolean { return this._fogEnabled; }
    public set fogEnabled(v: boolean) { this._fogEnabled = v; }
    public get fogDensity(): number { return this._fogDensity; }
    public set fogDensity(v: number) { this._fogDensity = Math.max(0, v); }
    public get fogStart(): number { return this._fogStart; }
    public set fogStart(v: number) { this._fogStart = Math.max(0, v); }
    public get fogHeight(): number { return this._fogHeight; }
    public set fogHeight(v: number) { this._fogHeight = v; }
    public get fogHeightFalloff(): number { return this._fogHeightFalloff; }
    public set fogHeightFalloff(v: number) { this._fogHeightFalloff = Math.max(0, v); }
    public get fogMaxOpacity(): number { return this._fogMaxOpacity; }
    public set fogMaxOpacity(v: number) { this._fogMaxOpacity = Math.min(1, Math.max(0, v)); }
    public get fogColor(): [number, number, number] { return this._fogColor; }
    public set fogColor(v: [number, number, number]) { this._fogColor = v; }
    public get fogColorBlend(): number { return this._fogColorBlend; }
    public set fogColorBlend(v: number) { this._fogColorBlend = Math.min(1, Math.max(0, v)); }

    // --- God rays (per-frame screen pass; setters do NOT flip needsBake) ---
    public get godRaysEnabled(): boolean { return this._godRaysEnabled; }
    public set godRaysEnabled(v: boolean) { this._godRaysEnabled = v; }
    public get godRaySamples(): number { return this._godRaySamples; }
    public set godRaySamples(v: number) { this._godRaySamples = Math.min(128, Math.max(8, Math.floor(v))); }
    public get godRayDensity(): number { return this._godRayDensity; }
    public set godRayDensity(v: number) { this._godRayDensity = Math.min(1, Math.max(0, v)); }
    public get godRayExposure(): number { return this._godRayExposure; }
    public set godRayExposure(v: number) { this._godRayExposure = Math.max(0, v); }
    public get godRayTint(): [number, number, number] { return this._godRayTint; }
    public set godRayTint(v: [number, number, number]) { this._godRayTint = v; }
    public get godRayAnisotropy(): number { return this._godRayAnisotropy; }
    public set godRayAnisotropy(v: number) { this._godRayAnisotropy = Math.min(0.95, Math.max(0, v)); }
    public get godRayMaxDistance(): number { return this._godRayMaxDistance; }
    public set godRayMaxDistance(v: number) { this._godRayMaxDistance = Math.min(1000, Math.max(5, v)); }

    // --- Night sky (baked into the cubemap; moonlightIntensity also scales its brightness) ---
    public get nightEnabled(): boolean { return this._nightEnabled; }
    public set nightEnabled(v: boolean) { this._nightEnabled = v; this._needsBake = true; }
    public get starIntensity(): number { return this._starIntensity; }
    public set starIntensity(v: number) { this._starIntensity = Math.max(0, v); this._needsBake = true; }
    public get starDensity(): number { return this._starDensity; }
    public set starDensity(v: number) { this._starDensity = Math.min(1, Math.max(0, v)); this._needsBake = true; }
    public get starColorVariance(): number { return this._starColorVariance; }
    public set starColorVariance(v: number) { this._starColorVariance = Math.min(1, Math.max(0, v)); this._needsBake = true; }
    public get nightSkyTexture(): string | null { return this._nightSkyTexture; }
    public set nightSkyTexture(v: string | null) { this._nightSkyTexture = v || null; this._needsBake = true; }
    public get nightSkyIntensity(): number { return this._nightSkyIntensity; }
    public set nightSkyIntensity(v: number) { this._nightSkyIntensity = Math.max(0, v); this._needsBake = true; }
    public get nightSkyRotation(): number { return this._nightSkyRotation; }
    public set nightSkyRotation(v: number) { this._nightSkyRotation = v; this._needsBake = true; }
    public get airglowColor(): [number, number, number] { return this._airglowColor; }
    public set airglowColor(v: [number, number, number]) { this._airglowColor = v; this._needsBake = true; }
    public get airglowIntensity(): number { return this._airglowIntensity; }
    public set airglowIntensity(v: number) { this._airglowIntensity = Math.max(0, v); this._needsBake = true; }
    public get moonEnabled(): boolean { return this._moonEnabled; }
    public set moonEnabled(v: boolean) { this._moonEnabled = v; this._needsBake = true; }
    public get moonTexture(): string | null { return this._moonTexture; }
    public set moonTexture(v: string | null) { this._moonTexture = v || null; this._needsBake = true; }
    public get moonSize(): number { return this._moonSize; }
    public set moonSize(v: number) { this._moonSize = Math.min(15, Math.max(0.1, v)); this._needsBake = true; }
    public get moonPhase(): number { return this._moonPhase; }
    public set moonPhase(v: number) { this._moonPhase = Math.min(1, Math.max(0, v)); this._needsBake = true; }
    public get moonOffsetYaw(): number { return this._moonOffsetYaw; }
    public set moonOffsetYaw(v: number) { this._moonOffsetYaw = v; this._needsBake = true; }
    public get moonOffsetPitch(): number { return this._moonOffsetPitch; }
    public set moonOffsetPitch(v: number) { this._moonOffsetPitch = v; this._needsBake = true; }
    public get moonColor(): [number, number, number] { return this._moonColor; }
    public set moonColor(v: [number, number, number]) { this._moonColor = v; this._needsBake = true; }
    public get moonIntensity(): number { return this._moonIntensity; }
    public set moonIntensity(v: number) { this._moonIntensity = Math.max(0, v); this._needsBake = true; }
    public get moonlightIntensity(): number { return this._moonlightIntensity; }
    public set moonlightIntensity(v: number) {
        const next = Math.min(1, Math.max(0, v));
        // The night sky's brightness follows it (see DEFAULT_MOONLIGHT_INTENSITY): a change re-bakes. Only a
        // change, since a time-of-day script writes the same value every frame.
        if (next !== this._moonlightIntensity) this._needsBake = true;
        this._moonlightIntensity = next;
    }

    // --- Runtime bake state (renderer-facing) ---
    public get cubemap(): Texture | null { return this._cubemap; }
    public get cubemapResolution(): number { return this._cubemapResolution; }
    public get needsBake(): boolean { return this._needsBake; }
    public get lastSunDir(): [number, number, number] { return this._lastSunDir; }
    /** Force a re-bake on the next frame (e.g. editor "Rebake" button). */
    public markDirty(): void { this._needsBake = true; }
    /** Store a freshly-created render-target cubemap (disposes any previous one). */
    public setCubemap(cube: Texture, resolution: number): void {
        if (this._cubemap && this._cubemap !== cube) this._cubemap.delete();
        this._cubemap = cube;
        this._cubemapResolution = resolution;
    }
    /** Mark the current cubemap as up-to-date for the given sun direction. */
    public markBaked(sunDir: [number, number, number]): void {
        this._needsBake = false;
        this._lastSunDir = [sunDir[0], sunDir[1], sunDir[2]];
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const radius = 1000;
        const min = vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius);
        const max = vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius);
        return { min, max };
    }

    /** Applies a preset by id (see SKY_ATMOSPHERE_PRESETS) or a preset object. Returns false for an unknown id. */
    public applyPreset(idOrPreset: string | SkyAtmospherePreset): boolean {
        return applyPreset(this, SKY_ATMOSPHERE_PRESETS, idOrPreset);
    }

    protected _serializePayload(): any {
        return {
                    atmosphere: {
                        useSceneSun: this._useSceneSun,
                        sunDirection: this._sunDirection,
                        sunColor: this._sunColor,
                        sunIntensity: this._sunIntensity,
                        rayleighScatter: this._rayleighScatter,
                        rayleighHeight: this._rayleighHeight,
                        mieScatter: this._mieScatter,
                        mieHeight: this._mieHeight,
                        mieG: this._mieG,
                        planetRadius: this._planetRadius,
                        atmosphereRadius: this._atmosphereRadius,
                        sunDiskSize: this._sunDiskSize,
                        exposure: this._exposure,
                        groundColor: this._groundColor,
                        resolution: this._resolution,
                        viewSteps: this._viewSteps,
                        lightSteps: this._lightSteps,
                        fogEnabled: this._fogEnabled,
                        fogDensity: this._fogDensity,
                        fogStart: this._fogStart,
                        fogHeight: this._fogHeight,
                        fogHeightFalloff: this._fogHeightFalloff,
                        fogMaxOpacity: this._fogMaxOpacity,
                        fogColor: this._fogColor,
                        fogColorBlend: this._fogColorBlend,
                        godRaysEnabled: this._godRaysEnabled,
                        godRaySamples: this._godRaySamples,
                        godRayDensity: this._godRayDensity,
                        godRayExposure: this._godRayExposure,
                        godRayTint: this._godRayTint,
                        godRayAnisotropy: this._godRayAnisotropy,
                        godRayMaxDistance: this._godRayMaxDistance,
                        nightEnabled: this._nightEnabled,
                        starIntensity: this._starIntensity,
                        starDensity: this._starDensity,
                        starColorVariance: this._starColorVariance,
                        nightSkyTexture: this._nightSkyTexture,
                        nightSkyIntensity: this._nightSkyIntensity,
                        nightSkyRotation: this._nightSkyRotation,
                        airglowColor: this._airglowColor,
                        airglowIntensity: this._airglowIntensity,
                        moonEnabled: this._moonEnabled,
                        moonTexture: this._moonTexture,
                        moonSize: this._moonSize,
                        moonPhase: this._moonPhase,
                        moonOffsetYaw: this._moonOffsetYaw,
                        moonOffsetPitch: this._moonOffsetPitch,
                        moonColor: this._moonColor,
                        moonIntensity: this._moonIntensity,
                        moonlightIntensity: this._moonlightIntensity
                    },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new SkyAtmosphereNode(json.name, json.atmosphere ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}
