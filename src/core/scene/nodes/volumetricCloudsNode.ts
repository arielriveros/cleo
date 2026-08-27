import { Shape } from "../../../physics/shape";
import type { Scene } from "../scene";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { SkyAtmosphereNode } from "./skyAtmosphereNode";

/**
 * Raymarched volumetric clouds. Scene singleton.
 */

export interface VolumetricCloudsOptions {
    // Shape
    coverage?: number;        // 0..1 — how much of the sky is filled
    density?: number;         // overall opacity multiplier
    cloudType?: number;       // 0..1 — stratus (flat) -> cumulus -> cumulonimbus (towering)
    baseAltitude?: number;    // world units — bottom of the cloud slab
    thickness?: number;       // world units — slab height
    baseScale?: number;       // low-frequency shape noise frequency
    detailScale?: number;     // high-frequency erosion noise frequency
    detailStrength?: number;  // 0..1 — how much detail erodes the base shape
    curlStrength?: number;    // domain-warp turbulence for wispy edges
    anvilBias?: number;       // 0..1 — spreads cloud tops outward (cumulonimbus anvil)
    // Lighting
    useSceneSun?: boolean;    // true = take direction/color from the scene directional light
    sunDirection?: [number, number, number]; // override travel direction (used when useSceneSun=false)
    sunColor?: [number, number, number];
    sunIntensity?: number;
    ambientColor?: [number, number, number];  // sky-side ambient
    ambientIntensity?: number;
    groundColor?: [number, number, number];    // ground bounce tint on cloud bottoms
    sunsetColor?: [number, number, number];    // sunrise/sunset glow: tints sun/ambient/ground while the sun crosses the horizon
    phaseG?: number;          // 0..1 — Henyey-Greenstein forward-scatter anisotropy
    silverIntensity?: number; // silver-lining boost near the sun
    silverSpread?: number;    // silver-lining angular spread
    powderStrength?: number;  // 0..1 — dark-edge (powder) effect
    absorption?: number;      // Beer's-law extinction coefficient
    // Animation
    windDirection?: [number, number, number]; // x/z used; drifts the cloud field over time
    windSpeed?: number;
    detailWindFactor?: number; // detail layer drifts faster than the base by this factor
    // Quality
    steps?: number;           // primary raymarch samples (16..192)
    lightSteps?: number;      // secondary (toward-sun) samples (2..12)
    maxDistance?: number;     // max ray length
    jitter?: boolean;         // dither the march start to hide banding
    resolutionScale?: number; // 0.25..1 — rays per screen axis (1 = one ray/pixel, 0.5 = one ray per 2x2 block)
    temporalUpscale?: boolean; // trace 1/16 of pixels per frame, reconstruct the rest from history
    // Render
    enabled?: boolean;
    opacity?: number;         // 0..1 — final composite opacity
}

/**
 * Scene-wide volumetric cloud layer. Holds only configuration, no GPU resources — the renderer
 * discovers it as a scene singleton and runs a single fullscreen raymarch pass.
 */
export class VolumetricCloudsNode extends Node {
    // Shape
    private _coverage: number;
    private _density: number;
    private _cloudType: number;
    private _baseAltitude: number;
    private _thickness: number;
    private _baseScale: number;
    private _detailScale: number;
    private _detailStrength: number;
    private _curlStrength: number;
    private _anvilBias: number;
    // Lighting
    private _useSceneSun: boolean;
    private _sunDirection: [number, number, number];
    private _sunColor: [number, number, number];
    private _sunIntensity: number;
    private _ambientColor: [number, number, number];
    private _ambientIntensity: number;
    private _groundColor: [number, number, number];
    private _sunsetColor: [number, number, number];
    private _phaseG: number;
    private _silverIntensity: number;
    private _silverSpread: number;
    private _powderStrength: number;
    private _absorption: number;
    // Animation
    private _windDirection: [number, number, number];
    private _windSpeed: number;
    private _detailWindFactor: number;
    // Quality
    private _steps: number;
    private _lightSteps: number;
    private _maxDistance: number;
    private _jitter: boolean;
    private _resolutionScale: number;
    private _temporalUpscale: boolean;
    // Render
    private _enabled: boolean;
    private _opacity: number;

    constructor(name: string, options: VolumetricCloudsOptions = {}, id: string = uuidv4()) {
        super(name, 'volumetricClouds', id);
        this._coverage = options.coverage ?? 0.5;
        this._density = options.density ?? 1.0;
        this._cloudType = options.cloudType ?? 0.5;
        this._baseAltitude = options.baseAltitude ?? 800;
        this._thickness = options.thickness ?? 700;
        this._baseScale = options.baseScale ?? 0.0004;
        this._detailScale = options.detailScale ?? 0.003;
        this._detailStrength = options.detailStrength ?? 0.35;
        this._curlStrength = options.curlStrength ?? 0.4;
        this._anvilBias = options.anvilBias ?? 0.0;

        this._useSceneSun = options.useSceneSun ?? true;
        this._sunDirection = options.sunDirection ?? [-0.5, -0.8, -0.35];
        this._sunColor = options.sunColor ?? [1.0, 0.95, 0.85];
        this._sunIntensity = options.sunIntensity ?? 10.0;
        this._ambientColor = options.ambientColor ?? [0.55, 0.65, 0.8];
        this._ambientIntensity = options.ambientIntensity ?? 1.0;
        this._groundColor = options.groundColor ?? [0.4, 0.4, 0.42];
        this._sunsetColor = options.sunsetColor ?? [1.0, 0.38, 0.16];
        this._phaseG = options.phaseG ?? 0.5;
        this._silverIntensity = options.silverIntensity ?? 0.6;
        this._silverSpread = options.silverSpread ?? 0.08;
        this._powderStrength = options.powderStrength ?? 0.5;
        this._absorption = options.absorption ?? 1.0;

        this._windDirection = options.windDirection ?? [1.0, 0.0, 0.2];
        this._windSpeed = options.windSpeed ?? 12.0;
        this._detailWindFactor = options.detailWindFactor ?? 2.0;

        this._steps = options.steps ?? 40;
        this._lightSteps = options.lightSteps ?? 5;
        this._maxDistance = options.maxDistance ?? 60000;
        this._jitter = options.jitter ?? true;
        // Half resolution by default: the raymarch is the most expensive pass in a cloudy frame and
        // produces a low-frequency image. Raise to 1.0 for a still capture.
        this._resolutionScale = options.resolutionScale ?? 0.5;
        // Bayer-subset temporal reprojection: trace 1/16 of the pixels per frame and reconstruct the
        // rest from reprojected history. Costs ghosting under fast camera or wind motion.
        this._temporalUpscale = options.temporalUpscale ?? true;

        this._enabled = options.enabled ?? true;
        this._opacity = options.opacity ?? 1.0;
    }

    // --- Shape ---
    public get coverage(): number { return this._coverage; }
    public set coverage(v: number) { this._coverage = Math.min(1, Math.max(0, v)); }
    public get density(): number { return this._density; }
    public set density(v: number) { this._density = Math.max(0, v); }
    public get cloudType(): number { return this._cloudType; }
    public set cloudType(v: number) { this._cloudType = Math.min(1, Math.max(0, v)); }
    public get baseAltitude(): number { return this._baseAltitude; }
    public set baseAltitude(v: number) { this._baseAltitude = v; }
    public get thickness(): number { return this._thickness; }
    public set thickness(v: number) { this._thickness = Math.max(1, v); }
    public get baseScale(): number { return this._baseScale; }
    public set baseScale(v: number) { this._baseScale = Math.max(0.00001, v); }
    public get detailScale(): number { return this._detailScale; }
    public set detailScale(v: number) { this._detailScale = Math.max(0.00001, v); }
    public get detailStrength(): number { return this._detailStrength; }
    public set detailStrength(v: number) { this._detailStrength = Math.min(1, Math.max(0, v)); }
    public get curlStrength(): number { return this._curlStrength; }
    public set curlStrength(v: number) { this._curlStrength = Math.max(0, v); }
    public get anvilBias(): number { return this._anvilBias; }
    public set anvilBias(v: number) { this._anvilBias = Math.min(1, Math.max(0, v)); }

    // --- Lighting ---
    public get useSceneSun(): boolean { return this._useSceneSun; }
    public set useSceneSun(v: boolean) { this._useSceneSun = v; }
    public get sunDirection(): [number, number, number] { return this._sunDirection; }
    public set sunDirection(v: [number, number, number]) { this._sunDirection = v; }
    public get sunColor(): [number, number, number] { return this._sunColor; }
    public set sunColor(v: [number, number, number]) { this._sunColor = v; }
    public get sunIntensity(): number { return this._sunIntensity; }
    public set sunIntensity(v: number) { this._sunIntensity = Math.max(0, v); }
    public get ambientColor(): [number, number, number] { return this._ambientColor; }
    public set ambientColor(v: [number, number, number]) { this._ambientColor = v; }
    public get ambientIntensity(): number { return this._ambientIntensity; }
    public set ambientIntensity(v: number) { this._ambientIntensity = Math.max(0, v); }
    public get groundColor(): [number, number, number] { return this._groundColor; }
    public set groundColor(v: [number, number, number]) { this._groundColor = v; }
    public get sunsetColor(): [number, number, number] { return this._sunsetColor; }
    public set sunsetColor(v: [number, number, number]) { this._sunsetColor = v; }
    public get phaseG(): number { return this._phaseG; }
    public set phaseG(v: number) { this._phaseG = Math.min(0.999, Math.max(0, v)); }
    public get silverIntensity(): number { return this._silverIntensity; }
    public set silverIntensity(v: number) { this._silverIntensity = Math.max(0, v); }
    public get silverSpread(): number { return this._silverSpread; }
    public set silverSpread(v: number) { this._silverSpread = Math.max(0.001, v); }
    public get powderStrength(): number { return this._powderStrength; }
    public set powderStrength(v: number) { this._powderStrength = Math.min(1, Math.max(0, v)); }
    public get absorption(): number { return this._absorption; }
    public set absorption(v: number) { this._absorption = Math.max(0, v); }

    // --- Animation ---
    public get windDirection(): [number, number, number] { return this._windDirection; }
    public set windDirection(v: [number, number, number]) { this._windDirection = v; }
    public get windSpeed(): number { return this._windSpeed; }
    public set windSpeed(v: number) { this._windSpeed = v; }
    public get detailWindFactor(): number { return this._detailWindFactor; }
    public set detailWindFactor(v: number) { this._detailWindFactor = v; }

    // --- Quality ---
    public get steps(): number { return this._steps; }
    public set steps(v: number) { this._steps = Math.min(192, Math.max(16, Math.floor(v))); }
    public get lightSteps(): number { return this._lightSteps; }
    public set lightSteps(v: number) { this._lightSteps = Math.min(12, Math.max(2, Math.floor(v))); }
    public get maxDistance(): number { return this._maxDistance; }
    public set maxDistance(v: number) { this._maxDistance = Math.max(1, v); }
    public get jitter(): boolean { return this._jitter; }
    public set jitter(v: boolean) { this._jitter = v; }
    public get resolutionScale(): number { return this._resolutionScale; }
    public set resolutionScale(v: number) { this._resolutionScale = Math.min(1, Math.max(0.25, v)); }
    public get temporalUpscale(): boolean { return this._temporalUpscale; }
    public set temporalUpscale(v: boolean) { this._temporalUpscale = v; }

    // --- Render ---
    public get enabled(): boolean { return this._enabled; }
    public set enabled(v: boolean) { this._enabled = v; }
    public get opacity(): number { return this._opacity; }
    public set opacity(v: number) { this._opacity = Math.min(1, Math.max(0, v)); }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const radius = 1000;
        const min = vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius);
        const max = vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius);
        return { min, max };
    }

    protected _serializePayload(): any {
        return {
                    clouds: {
                        coverage: this._coverage,
                        density: this._density,
                        cloudType: this._cloudType,
                        baseAltitude: this._baseAltitude,
                        thickness: this._thickness,
                        baseScale: this._baseScale,
                        detailScale: this._detailScale,
                        detailStrength: this._detailStrength,
                        curlStrength: this._curlStrength,
                        anvilBias: this._anvilBias,
                        useSceneSun: this._useSceneSun,
                        sunDirection: this._sunDirection,
                        sunColor: this._sunColor,
                        sunIntensity: this._sunIntensity,
                        ambientColor: this._ambientColor,
                        ambientIntensity: this._ambientIntensity,
                        groundColor: this._groundColor,
                        sunsetColor: this._sunsetColor,
                        phaseG: this._phaseG,
                        silverIntensity: this._silverIntensity,
                        silverSpread: this._silverSpread,
                        powderStrength: this._powderStrength,
                        absorption: this._absorption,
                        windDirection: this._windDirection,
                        windSpeed: this._windSpeed,
                        detailWindFactor: this._detailWindFactor,
                        steps: this._steps,
                        lightSteps: this._lightSteps,
                        maxDistance: this._maxDistance,
                        jitter: this._jitter,
                        resolutionScale: this._resolutionScale,
                        temporalUpscale: this._temporalUpscale,
                        enabled: this._enabled,
                        opacity: this._opacity
                    },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new VolumetricCloudsNode(json.name, json.clouds ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}
