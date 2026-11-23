// The engine's optional features: what a project can leave out of the games it publishes (Project ▸ Features
// in the editor). Pure data, so the editor's panels and the publish pipeline read it without loading any of
// the engine it describes.
//
// What leaving a feature out does, at publish:
//   - its node types are stripped from every scene and template (`strip`), before textures and sounds are
//     collected, so their data does not ship either;
//   - the render settings that would run it are turned off (`renderSettingsOff`);
//   - its shader modules are left out of the game's shader library (`shaderModules`, see
//     src/graphics/shaderLibrary.ts) -- for most features the bulk of what it weighs;
//   - a feature with code of its own in the player (the physics backends, today) leaves that out too.
// What uses a feature (Detect from Project, the pre-publish check): its node types, the material shading
// models it draws (`materialTypes`), the render settings that switch it on and the engine names a script
// imports from 'cleo' (`apiNames`).
//
// Modelled on Godot's build profiles (disabled classes and build options, detected from the project), with
// the compile step replaced by choosing from what the player was built with.

export type FeatureGroup = 'rendering' | 'world' | 'effects' | '2d' | 'simulation' | 'gameplay' | 'cinematic' | 'platform';

export const FEATURE_GROUPS: readonly { id: FeatureGroup; label: string }[] = [
    { id: 'rendering', label: 'Rendering' },
    { id: 'world', label: 'World' },
    { id: 'effects', label: 'Effects' },
    { id: '2d', label: '2D' },
    { id: 'simulation', label: 'Simulation' },
    { id: 'gameplay', label: 'Gameplay' },
    { id: 'cinematic', label: 'Cinematic' },
    { id: 'platform', label: 'Platform' },
];

export interface FeatureDef {
    readonly id: string;
    readonly label: string;
    /** One line for the Features panel. */
    readonly description: string;
    readonly group: FeatureGroup;
    /** Features it needs: leaving one of these out leaves this out too. */
    readonly dependsOn?: readonly string[];
    /** Node types only this feature has. */
    readonly nodeTypes?: readonly string[];
    /**
     * How a game without the feature loses one of its nodes: the whole subtree (a landscape and its
     * chunks), or the node alone, its children kept under a plain node in its place (a 2D body carries the
     * sprite it moves). Default: 'subtree'.
     */
    readonly strip?: 'subtree' | 'node';
    /** Shader modules only this feature draws with (ids under src/graphics/shaders: 'wgsl/ssr.wgsl'). */
    readonly shaderModules?: readonly string[];
    /** Material shading models that draw through it ('cel'): a model with one uses it. */
    readonly materialTypes?: readonly string[];
    /** Render settings that run it, turned off in a game without it. */
    readonly renderSettingsOff?: readonly string[];
    /**
     * Engine names (scripts' `import { X } from 'cleo'`) that belong to it, for a feature without code of its own
     * yet: once it has a module (src/modules/<id>/api.ts), that module's names are the list. A core name may be
     * here only as a feature's sole sign of use (`InputSystem`: input has no node); `TerrainMaterial` and
     * `Area2DNode` (a trigger) are core and used without their features.
     */
    readonly apiNames?: readonly string[];
    /**
     * Where the switch lives when it is not a strip: 'webgl2' is the publish option of that name, kept in step
     * with the Features panel.
     */
    readonly setting?: 'webgl2';
    /**
     * Experimental: it works and is documented, but its settings, data and look may still change between
     * versions. Only a label (the Features panel, the Add grid, the inspector, the docs and the agent's tools
     * show it); it switches nothing on or off.
     */
    readonly experimental?: boolean;
    /** What may change, for the label's tooltip and the inspector's notice. Default: EXPERIMENTAL_NOTE. */
    readonly experimentalNote?: string;
}

/** What an experimental feature's label says when it says nothing of its own. */
export const EXPERIMENTAL_NOTE = 'It is new and still changing: its settings and look may change in a later version.';

const wgsl = (...names: string[]) => names.map(n => `wgsl/${n}.wgsl`);

export const FEATURES: readonly FeatureDef[] = [
    // --- Rendering -------------------------------------------------------------------------------------------
    {
        id: 'gi', label: 'Global illumination', group: 'rendering',
        description: 'GI Volumes: baked and live bounce light from probe grids.',
        nodeTypes: ['giVolume'],
        shaderModules: wgsl('giReduce', 'giVisibility', 'giRadiance', 'giIntegrate', 'giResolve', 'giAmbientCube', 'giRescale', 'giStateStamp', 'giProbeOverlay'),
        renderSettingsOff: ['giEnabled'],
        apiNames: ['GIVolumeNode'],
    },
    {
        id: 'ssr', label: 'Screen-space reflections', group: 'rendering',
        description: 'Reflections traced through the depth buffer.',
        shaderModules: wgsl('ssr', 'ssrResolve', 'ssrTemporal'),
        renderSettingsOff: ['ssrEnabled'],
    },
    {
        id: 'ssil', label: 'Ambient occlusion & indirect light', group: 'rendering',
        description: 'Screen-space ambient occlusion and its bounce light (SSAO, SSIL).',
        shaderModules: wgsl('ssil', 'ssilTemporal', 'ssilBlur', 'ssilHistory'),
        renderSettingsOff: ['ssaoEnabled', 'ssilEnabled'],
    },
    {
        id: 'volumetricFog', label: 'Volumetric fog', group: 'rendering',
        description: 'Fog volumes lit by the sun and local lights.',
        nodeTypes: ['volumetricFog'],
        shaderModules: wgsl('volumetricFogInject', 'volumetricFogIntegrate', 'volumetricFogApply'),
        renderSettingsOff: ['volumetricFogEnabled'],
        apiNames: ['VolumetricFogNode'],
    },
    {
        id: 'volumetricClouds', label: 'Volumetric clouds', group: 'rendering',
        description: 'Raymarched cloud layers and the shadows they cast.',
        nodeTypes: ['volumetricClouds'],
        shaderModules: wgsl('volumetricClouds', 'cloudNoiseBake', 'cloudNoiseBakeCompute', 'cloudTemporalResolve', 'cloudUpsample'),
        apiNames: ['VolumetricCloudsNode'],
    },
    {
        id: 'skyAtmosphere', label: 'Sky atmosphere', group: 'rendering',
        description: 'A physically scattered sky and aerial perspective.',
        nodeTypes: ['skyAtmosphere'],
        shaderModules: wgsl('skyAtmosphere'),
        apiNames: ['SkyAtmosphereNode'],
    },
    {
        id: 'decals', label: 'Decals', group: 'rendering',
        description: 'Decal volumes projected onto surfaces.',
        nodeTypes: ['decal'],
        shaderModules: wgsl('decalSurface', 'decalResolve', 'decalColor'),
        apiNames: ['DecalNode'],
    },
    {
        id: 'celShading', label: 'Cel shading', group: 'rendering',
        description: 'The toon shading model for materials.',
        shaderModules: wgsl('cel', 'celSkinned'),
        materialTypes: ['cel'],
    },
    {
        id: 'blinnPhong', label: 'Blinn-Phong shading', group: 'rendering',
        description: 'The classic Blinn-Phong shading model for materials.',
        shaderModules: wgsl('blinnPhong', 'blinnPhongSkinned', 'geometryBlinnPhongSkinned', 'geometryBlinnPhongInstanced'),
        materialTypes: ['blinn_phong'],
    },

    // --- World -----------------------------------------------------------------------------------------------
    {
        id: 'landscape', label: 'Landscape', group: 'world',
        description: 'Sculpted terrain with painted layers, foliage and impostors.',
        nodeTypes: ['landscape'],
        shaderModules: wgsl('terrainForward', 'geometryTerrain', 'geometryFoliageBillboard', 'geometryFoliageImpostor', 'shadowMapImpostor', 'foliageCull', 'foliageCullArgs'),
        materialTypes: ['terrain'],
        apiNames: ['LandscapeNode', 'Terrain'],
    },
    {
        id: 'water', label: 'Water volumes', group: 'world',
        description: 'Rivers, lakes, pools and the sea: baked flow, live waves round the camera, floating bodies.',
        nodeTypes: ['waterVolume'],
        // The surface, the view from under it, the live waves and the local flow round the camera.
        shaderModules: wgsl('water', 'waterUnderwater', 'waterWaveField', 'waterWaveAdvect', 'waterWaveStep',
            'waterFlowGround', 'waterFlowShift', 'waterFlowAdvect', 'waterFlowLimit', 'waterFlowDepth', 'waterFlowAccelerate',
            'waterFlowWaves', 'waterFlowSurface'),
        apiNames: ['WaterVolumeNode'],
        experimental: true,
        experimentalNote: 'Water volumes are new and still changing: their settings, flow bakes and look may change in a later version, and a bake may need baking again.',
    },

    // --- Effects ---------------------------------------------------------------------------------------------
    {
        id: 'particles', label: 'Particles', group: 'effects',
        description: 'GPU particle systems and force fields.',
        nodeTypes: ['particleSystem', 'forceField'],
        shaderModules: wgsl('particleSim', 'particleSimCompute', 'particleBillboard', 'particleMesh', 'particleSort', 'particleSortCompute'),
        apiNames: ['ParticleSystemNode', 'ForceFieldNode'],
    },
    {
        id: 'fluids', label: 'Fire & smoke volumes', group: 'effects',
        description: 'Simulated fluid volumes for fire and smoke.',
        nodeTypes: ['fluidVolume'],
        shaderModules: wgsl('fluidVolume', 'fluidVolumeResolve', 'fluidVolumeComposite'),
        apiNames: ['FluidVolumeNode'],
    },
    {
        id: 'weather', label: 'Weather', group: 'effects',
        description: 'Weather volumes: rain, snow, wetness and puddles.',
        dependsOn: ['particles'],
        nodeTypes: ['weather'],
        apiNames: ['WeatherNode'],
    },

    // --- 2D --------------------------------------------------------------------------------------------------
    {
        id: 'world2d', label: '2D world', group: '2d',
        description: 'Tilemaps, 2D cameras, rooms and parallax layers.',
        nodeTypes: ['tilemap', 'camera2D', 'room2D', 'parallaxLayer'],
        shaderModules: wgsl('tilemap', 'pixelUpscale'),
        apiNames: ['TilemapNode', 'Tilemap', 'Camera2DNode', 'Room2DNode', 'ParallaxLayerNode'],
    },
    {
        id: 'physics2d', label: '2D physics', group: '2d',
        description: '2D character and rigid bodies, and 2D areas.',
        nodeTypes: ['characterBody2D', 'body2D', 'area2D'],
        strip: 'node',
        apiNames: ['CharacterBody2DNode', 'Body2DNode'],
    },

    // --- Simulation ------------------------------------------------------------------------------------------
    {
        id: 'cloth', label: 'Cloth', group: 'simulation',
        description: 'Simulated capes, banners and flags.',
        nodeTypes: ['cloth'],
        apiNames: ['ClothNode'],
        experimental: true,
        experimentalNote: 'Cloth is new and still changing: its settings, collision and look may change in a later version.',
    },
    {
        id: 'vehicles', label: 'Vehicles', group: 'simulation',
        description: 'Cars, trucks and karts: a body carried, driven and steered by its wheels.',
        nodeTypes: ['vehicle', 'wheel'],
        apiNames: ['VehicleNode', 'WheelNode', 'Vehicle'],
    },

    // --- Gameplay --------------------------------------------------------------------------------------------
    {
        id: 'input', label: 'Input', group: 'gameplay',
        description: 'The input map: keyboard, mouse, gamepad and touch controls.',
        apiNames: ['InputSystem'],
    },
    {
        id: 'ai', label: 'AI navigation', group: 'gameplay',
        description: 'Navmeshes that AI controllers path and patrol on.',
        nodeTypes: ['navMesh'],
        apiNames: ['NavMeshNode'],
    },
    {
        id: 'gameUi', label: 'Game UI', group: 'gameplay',
        description: 'UI nodes: menus, HUDs and their widgets.',
        nodeTypes: ['uiRoot', 'uiPanel', 'uiText', 'uiImage', 'uiButton', 'uiStack', 'uiSpacer', 'uiProgressBar', 'uiSlider', 'uiToggle', 'uiTextInput'],
        apiNames: ['UIRootNode', 'UINode'],
    },

    // --- Cinematic -------------------------------------------------------------------------------------------
    {
        id: 'sequencer', label: 'Cinematics', group: 'cinematic',
        description: 'Sequences: timed camera cuts, animation and events.',
        nodeTypes: ['sequence'],
        apiNames: ['SequenceNode', 'SequencePlayer'],
    },

    // --- Platform --------------------------------------------------------------------------------------------
    {
        id: 'webgl2', label: 'WebGL 2 fallback', group: 'platform',
        description: 'The WebGL 2 shaders, for browsers and devices without WebGPU.',
        setting: 'webgl2',
    },
];

export type FeatureId = typeof FEATURES[number]['id'];

const BY_ID = new Map(FEATURES.map(f => [f.id, f]));

/** A feature by id. */
export function featureById(id: string): FeatureDef | undefined {
    return BY_ID.get(id);
}

/**
 * The features a project's disabled list leaves on. A feature whose dependency is off is off too, and an id
 * the catalog does not know (a feature removed since) is ignored: a disabled list only ever takes away.
 */
export function enabledFeatures(disabled: readonly string[]): Set<string> {
    const off = new Set(disabled);
    const on = new Set<string>();
    const isOn = (f: FeatureDef, seen = new Set<string>()): boolean => {
        if (off.has(f.id) || seen.has(f.id)) return false;
        seen.add(f.id);
        return (f.dependsOn ?? []).every(d => { const dep = BY_ID.get(d); return !dep || isOn(dep, seen); });
    };
    for (const f of FEATURES) if (isOn(f)) on.add(f.id);
    return on;
}

/** The features that depend on `id`, directly or through another. */
export function dependentsOf(id: string): string[] {
    const out = new Set<string>();
    const visit = (target: string) => {
        for (const f of FEATURES) if (f.dependsOn?.includes(target) && !out.has(f.id)) { out.add(f.id); visit(f.id); }
    };
    visit(id);
    return [...out];
}

/** Which feature owns a node type, if one does (every other type is core). */
export function featureOfNodeType(type: string): FeatureDef | undefined {
    return FEATURES.find(f => f.nodeTypes?.includes(type));
}

/** Whether feature `id` is experimental (FeatureDef.experimental). */
export function isExperimentalFeature(id: string): boolean {
    return !!featureById(id)?.experimental;
}

/** The experimental feature a node type belongs to, if its feature is one. */
export function experimentalFeatureOfNodeType(type: string): FeatureDef | undefined {
    const f = featureOfNodeType(type);
    return f?.experimental ? f : undefined;
}

/** What an experimental feature's label says (its own note, else EXPERIMENTAL_NOTE). */
export function experimentalNoteOf(f: FeatureDef): string {
    return f.experimentalNote ?? EXPERIMENTAL_NOTE;
}

/** A starting point for a project's features: every box stays the user's to change. */
export interface FeaturePreset {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    /** The features it leaves out. */
    readonly disabled: readonly string[];
    /** The dimension a new project's first scene gets. */
    readonly dimension: '2D' | '3D';
}

const HIGH_END_3D = ['gi', 'ssr', 'volumetricClouds', 'fluids', 'cloth'];
const SHADING_MODELS = ['celShading', 'blinnPhong'];

export const FEATURE_PRESETS: readonly FeaturePreset[] = [
    {
        id: '2d', label: '2D', dimension: '2D',
        description: 'Tilemaps, sprites and 2D physics. No 3D world rendering.',
        disabled: ['gi', 'ssr', 'ssil', 'volumetricFog', 'volumetricClouds', 'skyAtmosphere', 'decals', ...SHADING_MODELS,
                   'landscape', 'water', 'fluids', 'weather', 'cloth', 'sequencer'],
    },
    {
        id: '2.5d', label: '2.5D', dimension: '3D',
        description: 'A 3D world played on a plane: sprites and 2D physics in 3D, lean lighting.',
        disabled: ['gi', 'ssr', 'volumetricFog', 'volumetricClouds', 'skyAtmosphere', ...SHADING_MODELS, 'landscape', 'fluids', 'weather', 'cloth', 'sequencer'],
    },
    {
        id: '3d', label: '3D', dimension: '3D',
        description: 'A 3D game: landscape, particles, decals, fog and sky. No 2D or high-end lighting.',
        disabled: ['world2d', 'physics2d', ...HIGH_END_3D, ...SHADING_MODELS],
    },
    {
        id: 'hifi3d', label: 'High-fidelity 3D', dimension: '3D',
        description: 'Every 3D feature: global illumination, reflections, clouds, weather and cloth.',
        disabled: ['world2d', 'physics2d', ...SHADING_MODELS],
    },
    {
        id: 'cinematic', label: 'Cinematic', dimension: '3D',
        description: 'A showcase that plays itself: full 3D rendering and sequences, no input or game UI.',
        disabled: ['input', 'gameUi', 'ai', 'world2d', 'physics2d', ...SHADING_MODELS],
    },
    {
        id: 'everything', label: 'Everything', dimension: '3D',
        description: 'Every feature the engine has. What a project starts with until it chooses.',
        disabled: [],
    },
];

/** The preset whose disabled list is exactly `disabled`, if one is. */
export function presetMatching(disabled: readonly string[]): FeaturePreset | undefined {
    const key = [...new Set(disabled)].sort().join(',');
    return FEATURE_PRESETS.find(p => [...new Set(p.disabled)].sort().join(',') === key);
}
