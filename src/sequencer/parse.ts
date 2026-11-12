import type {
    CameraCutSection, EventKey, FoliageSection, PathLook, PathSection, PresetSection, PropertySection, PropertyValueType,
    SectionBase, SequenceCurve, SequenceData, SequenceKey, SequenceSlot, SequenceTrack,
} from './types';
import { FOLIAGE_CHANNELS, SEQUENCE_VERSION } from './types';
import { finiteOr } from '../core/math';

/**
 * Tolerant parse of a stored sequence: malformed tracks, sections and keys are dropped rather than thrown on,
 * keys are sorted, sections are clamped to `start <= end`, and ids are filled in. What comes out is safe to
 * evaluate as is.
 */

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

let fallbackId = 0;
const idOf = (v: unknown, prefix: string): string =>
    (typeof v === 'string' && v.length > 0 ? v : `${prefix}${++fallbackId}`);

function vec3Of(v: unknown): [number, number, number] | null {
    if (!Array.isArray(v) || v.length < 3) return null;
    const out: [number, number, number] = [finiteOr(v[0], NaN), finiteOr(v[1], NaN), finiteOr(v[2], NaN)];
    return out.every(Number.isFinite) ? out : null;
}

function keyValue(v: unknown): SequenceKey['v'] | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'number' && Number.isFinite(x))) return v.slice();
    return undefined;
}

export function parseSequenceCurve(json: any): SequenceCurve | undefined {
    if (!json || !Array.isArray(json.keys)) return undefined;
    const keys: SequenceKey[] = [];
    for (const k of json.keys) {
        if (!k || typeof k !== 'object') continue;
        const v = keyValue(k.v);
        if (v === undefined) continue;
        const key: SequenceKey = { t: Math.max(0, finiteOr(k.t, 0)), v };
        if (k.interp === 'constant' || k.interp === 'linear' || k.interp === 'cubic' || k.interp === 'auto') key.interp = k.interp;
        keys.push(key);
    }
    if (keys.length === 0) return undefined;
    keys.sort((a, b) => a.t - b.t);
    return { keys };
}

function sectionBase(json: any, prefix: string): SectionBase {
    const start = Math.max(0, finiteOr(json?.start, 0));
    const end = Math.max(start, finiteOr(json?.end, start));
    const base: SectionBase = { id: idOf(json?.id, prefix), start, end };
    if (typeof json?.easeIn === 'number' && json.easeIn > 0) base.easeIn = json.easeIn;
    if (typeof json?.easeOut === 'number' && json.easeOut > 0) base.easeOut = json.easeOut;
    if (json?.whenFinished === 'restore' || json?.whenFinished === 'keep') base.whenFinished = json.whenFinished;
    if (typeof json?.label === 'string') base.label = json.label;
    return base;
}

function parseLook(json: any): PathLook | undefined {
    if (!json || typeof json !== 'object') return undefined;
    if (json.mode === 'ahead') return { mode: 'ahead', ...(typeof json.distance === 'number' ? { distance: json.distance } : {}) };
    if (json.mode === 'point') { const p = vec3Of(json.point); return p ? { mode: 'point', point: p } : undefined; }
    if (json.mode === 'slot' && typeof json.slot === 'string') {
        const offset = vec3Of(json.offset);
        return { mode: 'slot', slot: json.slot, ...(offset ? { offset } : {}) };
    }
    if (json.mode === 'path' && Array.isArray(json.points)) {
        const points = json.points.map(vec3Of).filter(Boolean) as [number, number, number][];
        if (points.length === 0) return undefined;
        const progress = parseSequenceCurve(json.progress) as SequenceCurve<number> | undefined;
        return { mode: 'path', points, ...(progress ? { progress } : {}) };
    }
    return undefined;
}

function parsePathSection(json: any): PathSection | null {
    const points = Array.isArray(json?.points) ? json.points.map(vec3Of).filter(Boolean) as [number, number, number][] : [];
    if (points.length === 0) return null;
    const section: PathSection = { ...sectionBase(json, 'path'), points };
    const progress = parseSequenceCurve(json.progress); if (progress) section.progress = progress as SequenceCurve<number>;
    const look = parseLook(json.look); if (look) section.look = look;
    const roll = parseSequenceCurve(json.roll); if (roll) section.roll = roll as SequenceCurve<number>;
    const fov = parseSequenceCurve(json.fov); if (fov) section.fov = fov as SequenceCurve<number>;
    return section;
}

const VALUE_TYPES: PropertyValueType[] = ['number', 'vector', 'bool', 'string'];

function parsePresetSection(json: any): PresetSection | null {
    const preset = str(json?.preset);
    if (!preset) return null;
    const section: PresetSection = { ...sectionBase(json, 'preset'), preset };
    if (typeof json.from === 'string' && json.from) section.from = json.from;
    return section;
}

/** A foliage section keeps the channels it has: numbers for the multipliers, on/off for the shadows. */
function parseFoliageSection(json: any): FoliageSection | null {
    if (!json || typeof json !== 'object') return null;
    const section: FoliageSection = sectionBase(json, 'foliage');
    for (const channel of FOLIAGE_CHANNELS) {
        const curve = parseSequenceCurve(json[channel]);
        if (!curve) continue;
        const want = channel === 'shadows' ? 'boolean' : 'number';
        const keys = curve.keys.filter(k => typeof k.v === want);
        if (keys.length > 0) (section as any)[channel] = { keys };
    }
    return section;
}

function parseTrack(json: any): SequenceTrack | null {
    if (!json || typeof json !== 'object') return null;
    const base = { id: idOf(json.id, 'track'), ...(typeof json.name === 'string' ? { name: json.name } : {}),
                   ...(json.muted === true ? { muted: true } : {}) };
    const sectionsOf = <T>(parse: (s: any) => T | null): T[] =>
        (Array.isArray(json.sections) ? json.sections : []).map(parse).filter((s: T | null): s is T => s !== null)
            .sort((a: any, b: any) => a.start - b.start);
    switch (json.type) {
        case 'path':
            if (typeof json.slot !== 'string') return null;
            return { ...base, type: 'path', slot: json.slot, sections: sectionsOf(parsePathSection) };
        case 'cameraCut':
            return { ...base, type: 'cameraCut', sections: sectionsOf<CameraCutSection>(s =>
                typeof s?.slot === 'string' ? { ...sectionBase(s, 'cut'), slot: s.slot } : null) };
        case 'property': {
            const path = str(json.path);
            if (!path) return null;
            const target = json.target === 'renderer' || json.target === 'game' ? json.target : undefined;
            if (!target && typeof json.slot !== 'string') return null;
            const valueType: PropertyValueType = VALUE_TYPES.includes(json.valueType) ? json.valueType : 'number';
            return {
                ...base, type: 'property', path, valueType,
                ...(target ? { target } : { slot: json.slot }),
                sections: sectionsOf<PropertySection>(s => {
                    const curve = parseSequenceCurve(s?.curve);
                    return curve ? { ...sectionBase(s, 'prop'), curve } : null;
                }),
            };
        }
        case 'event': {
            const keys: EventKey[] = (Array.isArray(json.keys) ? json.keys : [])
                .filter((k: any) => k && (typeof k.method === 'string' || typeof k.name === 'string'))
                .map((k: any) => ({
                    t: Math.max(0, finiteOr(k.t, 0)),
                    ...(typeof k.name === 'string' ? { name: k.name } : {}),
                    ...(typeof k.method === 'string' ? { method: k.method } : {}),
                    ...(typeof k.slot === 'string' ? { slot: k.slot } : {}),
                    ...(Array.isArray(k.args) ? { args: k.args } : {}),
                }))
                .sort((a: EventKey, b: EventKey) => a.t - b.t);
            return { ...base, type: 'event', keys };
        }
        case 'preset':
            if (typeof json.slot !== 'string') return null;
            return { ...base, type: 'preset', slot: json.slot, sections: sectionsOf(parsePresetSection) };
        case 'foliage': {
            if (typeof json.slot !== 'string') return null;
            const layers = Array.isArray(json.layers)
                ? json.layers.filter((n: unknown): n is string => typeof n === 'string' && n.length > 0) : 'all';
            return { ...base, type: 'foliage', slot: json.slot, layers, sections: sectionsOf(parseFoliageSection) };
        }
        default:
            return null;
    }
}

export function emptySequence(name = 'Sequence'): SequenceData {
    return { version: SEQUENCE_VERSION, name, duration: 10, fps: 30, clock: 'game', loop: false, slots: [], tracks: [], markers: [] };
}

export function parseSequence(json: any): SequenceData {
    const seq = emptySequence(str(json?.name, 'Sequence'));
    if (!json || typeof json !== 'object') return seq;
    seq.duration = Math.max(0, finiteOr(json.duration, seq.duration));
    seq.fps = Math.min(240, Math.max(1, finiteOr(json.fps, seq.fps)));
    seq.clock = json.clock === 'real' ? 'real' : 'game';
    seq.loop = json.loop === true;
    seq.slots = (Array.isArray(json.slots) ? json.slots : [])
        .filter((s: any) => s && typeof s.id === 'string')
        .map((s: any): SequenceSlot => ({
            id: s.id, name: str(s.name, s.id),
            ...(typeof s.nodeType === 'string' ? { nodeType: s.nodeType } : {}),
            ...(typeof s.path === 'string' ? { path: s.path } : {}),
        }));
    seq.tracks = (Array.isArray(json.tracks) ? json.tracks : []).map(parseTrack).filter(Boolean) as SequenceTrack[];
    seq.markers = (Array.isArray(json.markers) ? json.markers : [])
        .filter((m: any) => m && typeof m.name === 'string')
        .map((m: any) => ({ t: Math.max(0, finiteOr(m.t, 0)), name: m.name }))
        .sort((a: any, b: any) => a.t - b.t);
    return seq;
}
