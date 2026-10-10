// The particle system asset (`.vfx`): a list of emitters, each a stack of modules plus one renderer.
//
// The schema is plain JSON on purpose — it is stored in IndexedDB, embedded in scene nodes, shipped in
// bundles and diffed for undo — and every reader goes through `parseParticleSystem`, which is tolerant:
// unknown modules are dropped, missing params take their defaults, and nothing in an old or hand-edited
// file can make an emitter the GPU cannot run.

import { v4 as uuidv4 } from 'uuid';
import { moduleDefinition, defaultRenderSettings, type ParticleStage, type RenderSettings } from './particleModules';
import { parseParticleMesh } from './particleMesh';

export const PARTICLE_SYSTEM_VERSION = 1;

/** The largest capacity one emitter may ask for. Four RGBA32F textures at 262144 slots is 16 MB. */
export const MAX_EMITTER_CAPACITY = 262144;

export interface ParticleModule {
    type: string;
    enabled: boolean;
    params: Record<string, any>;
}

export interface EmitterDef {
    id: string;
    name: string;
    enabled: boolean;
    /** Live particles this emitter can hold. Spawns beyond it recycle the oldest slots. */
    capacity: number;
    /** `world`: particles stay where they were born. `local`: they move with the emitter. */
    simSpace: 'world' | 'local';
    /** Seconds per cycle. */
    duration: number;
    looping: boolean;
    /** Start a looping emitter as though it had already run a full cycle. */
    prewarm: boolean;
    /** Seconds before the first spawn. */
    startDelay: number;
    /** Base of every random draw; two emitters with the same seed and stack match particle for particle. */
    seed: number;
    spawn: ParticleModule[];
    init: ParticleModule[];
    update: ParticleModule[];
    render: RenderSettings;
}

export interface ParticleSystemDef {
    version: number;
    emitters: EmitterDef[];
    /**
     * Fixed local-space bounds every particle is assumed to stay inside, for culling and selection —
     * the Niagara model. GPU particles are never read back, so the bounds cannot be measured per frame.
     */
    bounds: { center: [number, number, number]; extents: [number, number, number] };
}

export function makeModule(type: string): ParticleModule {
    const def = moduleDefinition(type);
    return { type, enabled: true, params: def ? def.defaults() : {} };
}

/** A sensible starting emitter: soft, rising, turbulent puffs. What "new particle system" shows. */
export function defaultEmitter(name = 'Emitter'): EmitterDef {
    const velocity = makeModule('velocity');
    velocity.params.speed = [1, 2];
    return {
        id: uuidv4(), name, enabled: true, capacity: 2048, simSpace: 'world',
        duration: 5, looping: true, prewarm: false, startDelay: 0, seed: Math.floor(Math.random() * 1e6),
        spawn: [makeModule('spawnRate')],
        init: [makeModule('shape'), makeModule('lifetime'), velocity, makeModule('size'), makeModule('rotation'), makeModule('color')],
        update: [makeModule('drag'), makeModule('curlNoise'), makeModule('colorOverLife'), makeModule('sizeOverLife')],
        render: defaultRenderSettings(),
    };
}

export function defaultParticleSystem(): ParticleSystemDef {
    return {
        version: PARTICLE_SYSTEM_VERSION,
        emitters: [defaultEmitter()],
        bounds: { center: [0, 2, 0], extents: [3, 3, 3] },
    };
}

// --- Parsing --------------------------------------------------------------------------------------

const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const vec3Of = (x: unknown, fallback: [number, number, number]): [number, number, number] =>
    Array.isArray(x) ? [num(x[0], fallback[0]), num(x[1], fallback[1]), num(x[2], fallback[2])] : [...fallback];

function parseModules(raw: unknown, stage: ParticleStage): ParticleModule[] {
    if (!Array.isArray(raw)) return [];
    const out: ParticleModule[] = [];
    const seen = new Set<string>();
    for (const m of raw) {
        if (!m || typeof m.type !== 'string') continue;
        const def = moduleDefinition(m.type);
        // Wrong stage or unknown type: dropped, never coerced. A future module read by an older engine
        // simply has no effect, which is the only safe reading of it.
        if (!def || def.stage !== stage) continue;
        if (def.unique && seen.has(def.type)) continue;
        seen.add(def.type);
        const params = def.defaults();
        if (m.params && typeof m.params === 'object')
            for (const key of Object.keys(params))
                if (m.params[key] !== undefined && m.params[key] !== null) params[key] = m.params[key];
        out.push({ type: def.type, enabled: m.enabled !== false, params });
    }
    return out;
}

function parseRender(raw: any): RenderSettings {
    const base = defaultRenderSettings();
    if (!raw || typeof raw !== 'object') return base;
    const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
        options.includes(v as T) ? (v as T) : fallback;
    const fb = raw.flipbook ?? {};
    return {
        mode: pick(raw.mode, ['billboard', 'mesh'] as const, base.mode),
        alignment: pick(raw.alignment, ['camera', 'velocity', 'vertical', 'horizontal'] as const, base.alignment),
        blend: pick(raw.blend, ['alpha', 'additive', 'cutout'] as const, base.blend),
        stretch: Math.max(0, num(raw.stretch, base.stretch)),
        cutoff: Math.min(1, Math.max(0, num(raw.cutoff, base.cutoff))),
        textureId: typeof raw.textureId === 'string' && raw.textureId ? raw.textureId : null,
        flipbook: {
            columns: Math.max(1, Math.floor(num(fb.columns, 1))),
            rows: Math.max(1, Math.floor(num(fb.rows, 1))),
            frames: Math.max(1, Math.floor(num(fb.frames, Math.max(1, num(fb.columns, 1) * num(fb.rows, 1))))),
            mode: pick(fb.mode, ['life', 'fps'] as const, 'life'),
            fps: Math.max(0, num(fb.fps, 24)),
            cycles: Math.max(0, num(fb.cycles, 1)),
            randomStart: fb.randomStart === true,
            blend: fb.blend !== false,
        },
        softness: Math.max(0, num(raw.softness, base.softness)),
        emissive: Math.max(0, num(raw.emissive, base.emissive)),
        lit: raw.lit === true,
        mesh: pick(raw.mesh, ['cube', 'sphere', 'tetrahedron', 'cylinder', 'model'] as const, base.mesh),
        modelId: typeof raw.modelId === 'string' && raw.modelId ? raw.modelId : null,
        meshData: parseParticleMesh(raw.meshData),
        sort: raw.sort === true,
        sortingOrder: Math.floor(num(raw.sortingOrder, 0)),
    };
}

export function parseEmitter(raw: any, index = 0): EmitterDef {
    const base = defaultEmitter(`Emitter ${index + 1}`);
    if (!raw || typeof raw !== 'object') return base;
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
        name: typeof raw.name === 'string' && raw.name ? raw.name : base.name,
        enabled: raw.enabled !== false,
        capacity: Math.min(MAX_EMITTER_CAPACITY, Math.max(1, Math.floor(num(raw.capacity, base.capacity)))),
        simSpace: raw.simSpace === 'local' ? 'local' : 'world',
        duration: Math.max(0.01, num(raw.duration, base.duration)),
        looping: raw.looping !== false,
        prewarm: raw.prewarm === true,
        startDelay: Math.max(0, num(raw.startDelay, 0)),
        seed: Math.floor(num(raw.seed, base.seed)) >>> 0,
        // Absent arrays mean an empty stack, NOT the defaults: an author who removed every module meant it.
        spawn: Array.isArray(raw.spawn) ? parseModules(raw.spawn, 'spawn') : base.spawn,
        init: Array.isArray(raw.init) ? parseModules(raw.init, 'init') : base.init,
        update: Array.isArray(raw.update) ? parseModules(raw.update, 'update') : base.update,
        render: parseRender(raw.render),
    };
}

/** Read any JSON as a valid system. Never throws. */
export function parseParticleSystem(raw: any): ParticleSystemDef {
    if (!raw || typeof raw !== 'object') return defaultParticleSystem();
    const emitters = Array.isArray(raw.emitters) ? raw.emitters.map((e: any, i: number) => parseEmitter(e, i)) : [];
    const b = raw.bounds ?? {};
    return {
        version: PARTICLE_SYSTEM_VERSION,
        emitters,
        bounds: {
            center: vec3Of(b.center, [0, 2, 0]),
            extents: vec3Of(b.extents, [3, 3, 3]).map(v => Math.max(0.01, Math.abs(v))) as [number, number, number],
        },
    };
}

/** A deep copy through JSON — the asset is pure data, and this is the form every consumer stores. */
export function cloneParticleSystem(def: ParticleSystemDef): ParticleSystemDef {
    return JSON.parse(JSON.stringify(def));
}

/** The module of `type` in `emitter`, if present AND enabled. */
export function activeModule(emitter: EmitterDef, type: string): ParticleModule | undefined {
    for (const list of [emitter.spawn, emitter.init, emitter.update])
        for (const m of list) if (m.type === type && m.enabled) return m;
    return undefined;
}

/** The longest lifetime an emitter can give a particle, for "is the system still alive". */
export function maxLifetime(emitter: EmitterDef): number {
    const life = activeModule(emitter, 'lifetime');
    const range = life?.params.range;
    return Array.isArray(range) ? Math.max(num(range[0], 1), num(range[1], 1)) : 1;
}

/** Every asset id the system references, by kind — for the asset graph and bundle remapping. */
export function particleSystemReferences(def: ParticleSystemDef): { textures: string[]; models: string[] } {
    const textures = new Set<string>(), models = new Set<string>();
    for (const e of def.emitters) {
        if (e.render.textureId) textures.add(e.render.textureId);
        if (e.render.modelId) models.add(e.render.modelId);
    }
    return { textures: [...textures], models: [...models] };
}
