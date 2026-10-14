// The module catalogue: every module type an emitter stack can hold, its stage, its defaults, and the
// parameter schema the editor renders its card from.
//
// What a module DOES lives in exactly two places — `particlePack.ts` turns its params into uniforms and
// LUT rows, and the shared WGSL core applies them — and both are fixed-order. A stack's order is
// therefore presentation, not evaluation order: forces sum, and the core integrates them in one place.
// That is the Unity "module" model rather than Niagara's scriptable stack, and it is what lets ONE
// pre-compiled program serve every emitter on both backends with no shader permutations.

import { constantCurve, linearCurve, fadeGradient, whiteGradient, type Curve, type Gradient } from './curves';
import type { ParticleMeshData, ParticleMeshKind } from './particleMesh';

export type ParticleStage = 'spawn' | 'init' | 'update';

/** How the editor draws one parameter. The value lives in `module.params[key]`. */
export type ParamSpec =
    | { key: string; label: string; kind: 'float'; min?: number; max?: number; step?: number; unit?: string; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'int'; min?: number; max?: number; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'bool'; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'vec3'; unit?: string; hint?: string; when?: Predicate }
    /** [min, max], a uniform random pick per particle. */
    | { key: string; label: string; kind: 'range'; min?: number; max?: number; step?: number; unit?: string; hint?: string; when?: Predicate }
    /** [r, g, b, a], linear. */
    | { key: string; label: string; kind: 'color'; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'curve'; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'gradient'; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'enum'; options: { value: string; label: string }[]; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'bursts'; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'planes'; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'asset'; assetKind: 'model' | 'tileset' | 'texture'; hint?: string; when?: Predicate }
    | { key: string; label: string; kind: 'code'; hint?: string; when?: Predicate }
    /** Another emitter of the same system, by id. */
    | { key: string; label: string; kind: 'emitter'; hint?: string; when?: Predicate };

/** Show a parameter only when the module's other params satisfy this. Runtime-only, never serialized. */
export type Predicate = (params: Record<string, any>) => boolean;

export interface ModuleDefinition {
    type: string;
    stage: ParticleStage;
    label: string;
    description: string;
    /** At most one instance per emitter. Every module is, today; the flag keeps the editor honest. */
    unique: boolean;
    defaults: () => Record<string, any>;
    params: ParamSpec[];
}

export interface Burst {
    /** Seconds into the emitter's cycle. */
    time: number;
    count: number;
    /** Repetitions; 0 repeats for the rest of the cycle. */
    cycles: number;
    /** Seconds between repetitions. */
    interval: number;
    /** 0..1, rolled per repetition. */
    probability: number;
}

/** A world-space collision plane, as a point and a normal. Authored in the EMITTER's space. */
export interface CollisionPlane {
    point: [number, number, number];
    normal: [number, number, number];
}

const SHAPES = [
    { value: 'point', label: 'Point' }, { value: 'sphere', label: 'Sphere' },
    { value: 'hemisphere', label: 'Hemisphere' }, { value: 'cone', label: 'Cone' },
    { value: 'box', label: 'Box' }, { value: 'circle', label: 'Circle' }, { value: 'edge', label: 'Edge' },
];

const isShape = (...shapes: string[]): Predicate => p => shapes.includes(p.shape);

export const MODULES: readonly ModuleDefinition[] = [
    // --- Spawn ------------------------------------------------------------------------------------
    {
        type: 'spawnRate', stage: 'spawn', label: 'Spawn Rate', unique: true,
        description: 'Continuous emission, per second and per metre travelled.',
        defaults: () => ({ rate: 30, rateOverTime: constantCurve(1), perDistance: 0 }),
        params: [
            { key: 'rate', label: 'Rate', kind: 'float', min: 0, step: 1, unit: '/s' },
            { key: 'rateOverTime', label: 'Rate over cycle', kind: 'curve', hint: 'Multiplier over the emitter duration.' },
            { key: 'perDistance', label: 'Per distance', kind: 'float', min: 0, step: 0.1, unit: '/m', hint: 'Trails: particles per metre the emitter moves.' },
        ],
    },
    {
        type: 'subEmitter', stage: 'spawn', label: 'Sub-Emitter', unique: true,
        description: 'Spawn from another emitter\'s particles when they die or collide, instead of on a timer.',
        defaults: () => ({ parent: null as string | null, event: 'death', count: 4, inherit: 0.2 }),
        params: [
            { key: 'parent', label: 'Parent emitter', kind: 'emitter' },
            { key: 'event', label: 'On', kind: 'enum', options: [{ value: 'death', label: 'Parent death' }, { value: 'collision', label: 'Parent collision' }] },
            { key: 'count', label: 'Per event', kind: 'int', min: 1, max: 8, hint: 'Particles born per event. Capacity becomes the parent\'s capacity times this.' },
            { key: 'inherit', label: 'Inherit velocity', kind: 'float', min: 0, max: 1, step: 0.05 },
        ],
    },
    {
        type: 'spawnBurst', stage: 'spawn', label: 'Bursts', unique: true,
        description: 'Instant emissions at fixed times in the cycle.',
        defaults: () => ({ bursts: [{ time: 0, count: 30, cycles: 1, interval: 0.5, probability: 1 }] as Burst[] }),
        params: [{ key: 'bursts', label: 'Bursts', kind: 'bursts' }],
    },

    // --- Initialize -------------------------------------------------------------------------------
    {
        type: 'shape', stage: 'init', label: 'Shape', unique: true,
        description: 'Where particles are born, and the direction "shape" velocity uses.',
        defaults: () => ({ shape: 'cone', radius: 0.25, thickness: 1, arc: 360, angle: 20,
                           box: [1, 1, 1], offset: [0, 0, 0] }),
        params: [
            { key: 'shape', label: 'Shape', kind: 'enum', options: SHAPES },
            { key: 'radius', label: 'Radius', kind: 'float', min: 0, step: 0.05, unit: 'm', when: p => p.shape !== 'point' && p.shape !== 'box' },
            { key: 'thickness', label: 'Volume', kind: 'float', min: 0, max: 1, step: 0.05, hint: '0 emits from the surface, 1 from the whole volume.', when: isShape('sphere', 'hemisphere', 'cone', 'circle') },
            { key: 'arc', label: 'Arc', kind: 'float', min: 0, max: 360, step: 1, unit: '°', when: isShape('cone', 'circle') },
            { key: 'angle', label: 'Cone angle', kind: 'float', min: 0, max: 89, step: 1, unit: '°', when: isShape('cone') },
            { key: 'box', label: 'Size', kind: 'vec3', unit: 'm', when: isShape('box') },
            { key: 'offset', label: 'Offset', kind: 'vec3', unit: 'm' },
        ],
    },
    {
        type: 'lifetime', stage: 'init', label: 'Lifetime', unique: true,
        description: 'Seconds each particle lives.',
        defaults: () => ({ range: [1, 2] }),
        params: [{ key: 'range', label: 'Lifetime', kind: 'range', min: 0.01, step: 0.05, unit: 's' }],
    },
    {
        type: 'velocity', stage: 'init', label: 'Velocity', unique: true,
        description: 'Initial speed and direction.',
        defaults: () => ({ mode: 'shape', direction: [0, 1, 0], spread: 0, speed: [1, 2], inherit: 0 }),
        params: [
            { key: 'mode', label: 'Direction', kind: 'enum', options: [
                { value: 'shape', label: 'From shape' }, { value: 'direction', label: 'Fixed direction' },
                { value: 'radial', label: 'Radial' }] },
            { key: 'direction', label: 'Direction', kind: 'vec3', when: p => p.mode === 'direction' },
            { key: 'spread', label: 'Spread', kind: 'float', min: 0, max: 180, step: 1, unit: '°' },
            { key: 'speed', label: 'Speed', kind: 'range', step: 0.1, unit: 'm/s' },
            { key: 'inherit', label: 'Inherit emitter', kind: 'float', min: 0, max: 1, step: 0.05, hint: 'Fraction of the emitter\'s own velocity added at birth.' },
        ],
    },
    {
        type: 'size', stage: 'init', label: 'Size', unique: true,
        description: 'Initial size, in metres.',
        defaults: () => ({ range: [0.2, 0.4] }),
        params: [{ key: 'range', label: 'Size', kind: 'range', min: 0, step: 0.01, unit: 'm' }],
    },
    {
        type: 'rotation', stage: 'init', label: 'Rotation', unique: true,
        description: 'Initial angle and spin of each sprite.',
        defaults: () => ({ angle: [0, 360], spin: [0, 0] }),
        params: [
            { key: 'angle', label: 'Angle', kind: 'range', step: 1, unit: '°' },
            { key: 'spin', label: 'Angular velocity', kind: 'range', step: 1, unit: '°/s' },
        ],
    },
    {
        type: 'color', stage: 'init', label: 'Color', unique: true,
        description: 'Initial colour. HDR values above 1 glow through bloom.',
        defaults: () => ({ mode: 'constant', colorA: [1, 1, 1, 1], colorB: [1, 0.5, 0.2, 1],
                           gradient: whiteGradient(), intensity: 1 }),
        params: [
            { key: 'mode', label: 'Mode', kind: 'enum', options: [
                { value: 'constant', label: 'Constant' }, { value: 'between', label: 'Random between' },
                { value: 'gradient', label: 'Random from gradient' }] },
            { key: 'colorA', label: 'Color', kind: 'color', when: p => p.mode !== 'gradient' },
            { key: 'colorB', label: 'Color B', kind: 'color', when: p => p.mode === 'between' },
            { key: 'gradient', label: 'Gradient', kind: 'gradient', when: p => p.mode === 'gradient' },
            { key: 'intensity', label: 'Intensity', kind: 'float', min: 0, step: 0.1, hint: 'HDR multiplier.' },
        ],
    },

    // --- Update -----------------------------------------------------------------------------------
    {
        type: 'gravity', stage: 'update', label: 'Gravity', unique: true,
        description: 'The scene\'s gravity, scaled.',
        defaults: () => ({ scale: 1 }),
        params: [{ key: 'scale', label: 'Scale', kind: 'float', step: 0.05, hint: 'Negative makes particles rise.' }],
    },
    {
        type: 'drag', stage: 'update', label: 'Drag', unique: true,
        description: 'Linear air resistance.',
        defaults: () => ({ coefficient: 0.5 }),
        params: [{ key: 'coefficient', label: 'Coefficient', kind: 'float', min: 0, step: 0.05, unit: '/s' }],
    },
    {
        type: 'wind', stage: 'update', label: 'Wind', unique: true,
        description: 'Pulls velocity toward a wind velocity, plus any directional force fields in the scene.',
        defaults: () => ({ velocity: [2, 0, 0], influence: 1 }),
        params: [
            { key: 'velocity', label: 'Velocity', kind: 'vec3', unit: 'm/s' },
            { key: 'influence', label: 'Coupling', kind: 'float', min: 0, step: 0.05, unit: '/s', hint: 'How fast particles reach the wind speed.' },
        ],
    },
    {
        type: 'curlNoise', stage: 'update', label: 'Turbulence', unique: true,
        description: 'Divergence-free curl noise — swirling smoke without clumping.',
        defaults: () => ({ strength: 1.5, frequency: 0.6, scroll: 0.3, octaves: 1 }),
        params: [
            { key: 'strength', label: 'Strength', kind: 'float', min: 0, step: 0.1, unit: 'm/s²' },
            { key: 'frequency', label: 'Frequency', kind: 'float', min: 0.001, step: 0.05, unit: '/m' },
            { key: 'scroll', label: 'Scroll', kind: 'float', step: 0.05, unit: '/s' },
            { key: 'octaves', label: 'Octaves', kind: 'int', min: 1, max: 3 },
        ],
    },
    {
        type: 'vortex', stage: 'update', label: 'Vortex', unique: true,
        description: 'Spin around an axis through the emitter.',
        defaults: () => ({ axis: [0, 1, 0], center: [0, 0, 0], strength: 3, pull: 0 }),
        params: [
            { key: 'axis', label: 'Axis', kind: 'vec3' },
            { key: 'center', label: 'Center', kind: 'vec3', unit: 'm' },
            { key: 'strength', label: 'Strength', kind: 'float', step: 0.1, unit: 'm/s²' },
            { key: 'pull', label: 'Pull', kind: 'float', step: 0.1, unit: 'm/s²', hint: 'Inward (positive) or outward force.' },
        ],
    },
    {
        type: 'attractor', stage: 'update', label: 'Point Attractor', unique: true,
        description: 'Accelerates particles toward a point.',
        defaults: () => ({ position: [0, 1, 0], strength: 5, radius: 0, killRadius: 0 }),
        params: [
            { key: 'position', label: 'Position', kind: 'vec3', unit: 'm' },
            { key: 'strength', label: 'Strength', kind: 'float', step: 0.1, unit: 'm/s²', hint: 'Negative repels.' },
            { key: 'radius', label: 'Falloff radius', kind: 'float', min: 0, step: 0.1, unit: 'm', hint: '0 means no falloff.' },
            { key: 'killRadius', label: 'Kill radius', kind: 'float', min: 0, step: 0.05, unit: 'm' },
        ],
    },
    {
        type: 'forceFields', stage: 'update', label: 'Force Fields', unique: true,
        description: 'Responds to Force Field nodes placed in the scene.',
        defaults: () => ({ influence: 1 }),
        params: [{ key: 'influence', label: 'Influence', kind: 'float', min: 0, step: 0.05 }],
    },
    {
        type: 'limitVelocity', stage: 'update', label: 'Limit Velocity', unique: true,
        description: 'Caps speed, softly.',
        defaults: () => ({ maxSpeed: 5, dampen: 0.5 }),
        params: [
            { key: 'maxSpeed', label: 'Max speed', kind: 'float', min: 0, step: 0.1, unit: 'm/s' },
            { key: 'dampen', label: 'Dampen', kind: 'float', min: 0, max: 1, step: 0.05, hint: 'Fraction of the excess removed per step.' },
        ],
    },
    {
        type: 'speedOverLife', stage: 'update', label: 'Speed over Life', unique: true,
        description: 'Scales how far particles move per second over their life.',
        defaults: () => ({ curve: linearCurve(1, 0.2) }),
        params: [{ key: 'curve', label: 'Multiplier', kind: 'curve' }],
    },
    {
        type: 'collision', stage: 'update', label: 'Collision', unique: true,
        description: 'Bounces off physics bodies, visible geometry (scene depth) and authored planes.',
        defaults: () => ({ bodies: true, depth: true, planes: [] as CollisionPlane[], radius: 0.5, restitution: 0.4,
                           friction: 0.2, lifetimeLoss: 0, kill: false, thickness: 0.5 }),
        params: [
            { key: 'bodies', label: 'Physics bodies', kind: 'bool', hint: 'Collides with the colliders near the effect — floors, walls, props, characters — on or off screen. Moving bodies push particles along. Spheres, boxes, capsules, planes and convex hulls; terrain and mesh colliders need Scene depth.' },
            { key: 'depth', label: 'Scene depth', kind: 'bool', hint: 'Collides with whatever is on screen. Off-screen particles pass through.' },
            { key: 'thickness', label: 'Surface thickness', kind: 'float', min: 0.01, step: 0.05, unit: 'm', when: p => !!p.depth, hint: 'How far behind a surface still counts as inside it.' },
            { key: 'planes', label: 'Planes', kind: 'planes', hint: 'Work everywhere, including 2D and off-screen.' },
            { key: 'radius', label: 'Radius scale', kind: 'float', min: 0, step: 0.05, hint: 'Collision radius as a fraction of the particle size.' },
            { key: 'restitution', label: 'Bounce', kind: 'float', min: 0, max: 1, step: 0.05 },
            { key: 'friction', label: 'Friction', kind: 'float', min: 0, max: 1, step: 0.05 },
            { key: 'lifetimeLoss', label: 'Lifetime loss', kind: 'float', min: 0, max: 1, step: 0.05, hint: 'Fraction of the lifetime removed per hit.' },
            { key: 'kill', label: 'Kill on hit', kind: 'bool' },
        ],
    },
    {
        type: 'colorOverLife', stage: 'update', label: 'Color over Life', unique: true,
        description: 'Multiplies colour and alpha over each particle\'s life.',
        defaults: () => ({ gradient: fadeGradient() }),
        params: [{ key: 'gradient', label: 'Gradient', kind: 'gradient' }],
    },
    {
        type: 'sizeOverLife', stage: 'update', label: 'Size over Life', unique: true,
        description: 'Multiplies size over each particle\'s life.',
        defaults: () => ({ curve: linearCurve(0.5, 1.5) }),
        params: [{ key: 'curve', label: 'Multiplier', kind: 'curve' }],
    },
    {
        type: 'rotationOverLife', stage: 'update', label: 'Spin over Life', unique: true,
        description: 'Multiplies angular velocity over each particle\'s life.',
        defaults: () => ({ curve: linearCurve(1, 0) }),
        params: [{ key: 'curve', label: 'Multiplier', kind: 'curve' }],
    },
    {
        type: 'colorBySpeed', stage: 'update', label: 'Color by Speed', unique: true,
        description: 'Multiplies colour by a gradient over a speed range.',
        defaults: () => ({ gradient: whiteGradient(), speed: [0, 5] }),
        params: [
            { key: 'gradient', label: 'Gradient', kind: 'gradient' },
            { key: 'speed', label: 'Speed range', kind: 'range', min: 0, step: 0.1, unit: 'm/s' },
        ],
    },
    {
        type: 'sizeBySpeed', stage: 'update', label: 'Size by Speed', unique: true,
        description: 'Multiplies size by a curve over a speed range.',
        defaults: () => ({ curve: linearCurve(1, 0.5), speed: [0, 5] }),
        params: [
            { key: 'curve', label: 'Multiplier', kind: 'curve' },
            { key: 'speed', label: 'Speed range', kind: 'range', min: 0, step: 0.1, unit: 'm/s' },
        ],
    },
    {
        type: 'customCode', stage: 'update', label: 'Custom Code', unique: true,
        description: 'Your own WGSL, run on every live particle after the built-in update. Runs once compiled.',
        // `compiled` is written by the editor's Compile and never shown: see particleCustomCode.ts.
        defaults: () => ({ source: DEFAULT_CUSTOM_SOURCE, params: [0, 0, 0, 0], compiled: null }),
        params: [
            { key: 'params', label: 'u_custom (x, y, z, w)', kind: 'vec3', hint: 'Four floats your code reads as `custom.x` ... `custom.w`.' },
            { key: 'source', label: 'Code', kind: 'code' },
        ],
    },
];

/**
 * The body of `fn particleCustomUpdate(p: ptr<function, Particle>, dt: f32, custom: vec4<f32>)`. WGSL
 * because it is spliced into the WGSL core and the WebGL2 program is translated from that.
 */
export const DEFAULT_CUSTOM_SOURCE =
`// p: the particle (position, velocity, age, lifetime, size, rotation, color)
// dt: seconds this step, custom: the four values above
// Example: a gentle sideways wobble.
(*p).velocity.x += sin((*p).age * 6.0 + (*p).seed * 30.0) * custom.x * dt;`;

const BY_TYPE = new Map(MODULES.map(m => [m.type, m]));

export function moduleDefinition(type: string): ModuleDefinition | undefined {
    return BY_TYPE.get(type);
}

export function modulesForStage(stage: ParticleStage): ModuleDefinition[] {
    return MODULES.filter(m => m.stage === stage);
}

// --- Render ----------------------------------------------------------------------------------------

/** The render settings, one per emitter. Not a stack module: an emitter draws exactly one way. */
export interface RenderSettings {
    mode: 'billboard' | 'mesh';
    /** camera: face the camera. velocity: stretch along motion. vertical: rotate about world Y. horizontal: lie flat. */
    alignment: 'camera' | 'velocity' | 'vertical' | 'horizontal';
    blend: 'alpha' | 'additive' | 'cutout';
    /** Extra length per m/s of speed, in sizes, for `velocity` alignment. */
    stretch: number;
    /** Alpha below which `cutout` discards. */
    cutoff: number;
    /** A texture asset id, or a tileset id for a flipbook. Null draws a soft procedural disc. */
    textureId: string | null;
    /** Flipbook layout over `textureId`. 1x1 is a plain texture. */
    flipbook: { columns: number; rows: number; frames: number; mode: 'life' | 'fps'; fps: number; cycles: number; randomStart: boolean; blend: boolean };
    /** Fade near opaque geometry over this many metres; 0 disables. */
    softness: number;
    /** Multiplies the final colour — HDR, in the scene's internal radiance units. */
    emissive: number;
    /** Simple lighting: sky ambient plus the sun. Off draws unlit. */
    lit: boolean;
    /** For `mesh` mode: a built-in shape, or `model` for `meshData`. */
    mesh: ParticleMeshKind;
    /** The model asset `meshData` was captured from — informational, for the editor and the asset graph. */
    modelId: string | null;
    /** The captured model geometry, unit diameter. Embedded so a published game needs no model library. */
    meshData: ParticleMeshData | null;
    /**
     * Draw back to front within the emitter (a GPU bitonic sort, every frame). Only alpha blending needs
     * it — additive and cutout are order-independent — and it costs log2(N)^2/2 passes, so it is opt-in.
     */
    sort: boolean;
    /** Draw order within the 2D pass, and the tie-break between emitters in 3D. */
    sortingOrder: number;
}

export function defaultRenderSettings(): RenderSettings {
    return {
        mode: 'billboard', alignment: 'camera', blend: 'alpha', stretch: 0.1, cutoff: 0.5,
        textureId: null,
        flipbook: { columns: 1, rows: 1, frames: 1, mode: 'life', fps: 24, cycles: 1, randomStart: false, blend: true },
        softness: 0.3, emissive: 1, lit: false, mesh: 'cube', modelId: null, meshData: null, sort: false, sortingOrder: 0,
    };
}

export const RENDER_PARAMS: ParamSpec[] = [
    { key: 'mode', label: 'Renderer', kind: 'enum', options: [{ value: 'billboard', label: 'Billboard' }, { value: 'mesh', label: 'Mesh' }] },
    { key: 'mesh', label: 'Mesh', kind: 'enum', when: p => p.mode === 'mesh', options: [
        { value: 'cube', label: 'Cube' }, { value: 'sphere', label: 'Sphere' }, { value: 'tetrahedron', label: 'Shard' },
        { value: 'cylinder', label: 'Cylinder' }, { value: 'model', label: 'Model asset' }] },
    { key: 'modelId', label: 'Model', kind: 'asset', assetKind: 'model', when: p => p.mode === 'mesh' && p.mesh === 'model',
      hint: 'Its geometry is copied into the effect when picked; re-pick it to pick up later edits.' },
    { key: 'alignment', label: 'Alignment', kind: 'enum', hint: 'Meshes: Face camera tumbles them; Stretch points their +Y along the motion.', options: [
        { value: 'camera', label: 'Face camera' }, { value: 'velocity', label: 'Stretch along velocity' },
        { value: 'vertical', label: 'Vertical (about Y)' }, { value: 'horizontal', label: 'Horizontal' }] },
    { key: 'stretch', label: 'Stretch', kind: 'float', min: 0, step: 0.01, when: p => p.alignment === 'velocity' },
    { key: 'blend', label: 'Blend', kind: 'enum', options: [
        { value: 'alpha', label: 'Alpha' }, { value: 'additive', label: 'Additive' }, { value: 'cutout', label: 'Cutout' }] },
    { key: 'cutoff', label: 'Cutoff', kind: 'float', min: 0, max: 1, step: 0.05, when: p => p.blend === 'cutout' },
    { key: 'textureId', label: 'Texture', kind: 'asset', assetKind: 'texture' },
    { key: 'softness', label: 'Soft fade', kind: 'float', min: 0, step: 0.05, unit: 'm' },
    { key: 'emissive', label: 'Brightness', kind: 'float', min: 0, step: 0.1 },
    { key: 'lit', label: 'Lit', kind: 'bool' },
    { key: 'sort', label: 'Sort particles', kind: 'bool', when: p => p.blend === 'alpha',
      hint: 'Back to front, on the GPU, every frame. Fixes dark fringes where alpha puffs overlap; costs a few passes.' },
    { key: 'sortingOrder', label: 'Sorting order', kind: 'int', hint: 'Higher draws later (on top). In 2D, offsets the emitter sorting band.' },
];
