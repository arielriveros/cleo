import { describe, it, expect } from 'vitest';
import {
    DEFAULT_SOUND_SETTINGS, DEFAULT_SPATIAL_SETTINGS, EFFECT_KINDS, BUS_IDS,
    clampSettings, defaultEffect, normalizeEffect, normalizeEffects, parseSoundSettings,
    parseSpatialSettings, rackShapeOf,
} from '../src/audio/soundSettings';
import type { SoundEffect, SoundSettings } from '../src/audio/soundSettings';

// soundSettings.ts is the audio stack's tolerant reader: every path that turns saved JSON into settings
// goes through it, and nothing downstream validates again. So the cases that matter here are the hostile
// ones — a field from a newer build, a NaN, a loop region that ends before it starts — because in the app
// those arrive from a project file rather than from a test.

describe('defaultEffect', () => {
    it('produces one for every kind, tagged with that kind', () => {
        for (const kind of EFFECT_KINDS) {
            const e = defaultEffect(kind);
            expect(e.kind).toBe(kind);
            expect(e.enabled).toBe(true);
        }
    });

    it('defaults are inaudible or gentle, so adding an insert never surprises', () => {
        const filter = defaultEffect('filter') as Extract<SoundEffect, { kind: 'filter' }>;
        // A lowpass at the top of the audible range passes everything: adding a filter changes nothing
        // until the user moves the slider.
        expect(filter.type).toBe('lowpass');
        expect(filter.frequency).toBe(20000);

        const delay = defaultEffect('delay') as Extract<SoundEffect, { kind: 'delay' }>;
        expect(delay.feedback).toBeLessThan(0.95);
    });
});

describe('normalizeEffect', () => {
    it('rejects non-objects and unknown kinds', () => {
        expect(normalizeEffect(null)).toBeNull();
        expect(normalizeEffect('filter')).toBeNull();
        expect(normalizeEffect({})).toBeNull();
        expect(normalizeEffect({ kind: 'granulator' })).toBeNull();
    });

    it('treats a missing `enabled` as on, and only an explicit false as off', () => {
        expect(normalizeEffect({ kind: 'reverb' })!.enabled).toBe(true);
        expect(normalizeEffect({ kind: 'reverb', enabled: false })!.enabled).toBe(false);
        expect(normalizeEffect({ kind: 'reverb', enabled: 0 })!.enabled).toBe(true);
    });

    it('fills missing parameters from the default for that kind', () => {
        const e = normalizeEffect({ kind: 'compressor' }) as Extract<SoundEffect, { kind: 'compressor' }>;
        expect(e).toEqual(defaultEffect('compressor'));
    });

    it('clamps every parameter into the range its Web Audio node accepts', () => {
        const filter = normalizeEffect(
            { kind: 'filter', frequency: 1e9, q: -5 },
        ) as Extract<SoundEffect, { kind: 'filter' }>;
        expect(filter.frequency).toBe(20000);
        expect(filter.q).toBeGreaterThan(0);

        // Feedback at or above 1 is a runaway loop that pins the output; it must be held below.
        const delay = normalizeEffect(
            { kind: 'delay', feedback: 3, time: 99 },
        ) as Extract<SoundEffect, { kind: 'delay' }>;
        expect(delay.feedback).toBeLessThan(1);
        expect(delay.time).toBeLessThanOrEqual(5);

        // DynamicsCompressorNode throws outside these; clamping is what keeps a bad record from crashing.
        const comp = normalizeEffect(
            { kind: 'compressor', threshold: 50, ratio: 1000, knee: -3 },
        ) as Extract<SoundEffect, { kind: 'compressor' }>;
        expect(comp.threshold).toBeLessThanOrEqual(0);
        expect(comp.threshold).toBeGreaterThanOrEqual(-100);
        expect(comp.ratio).toBeLessThanOrEqual(20);
        expect(comp.knee).toBeGreaterThanOrEqual(0);
    });

    it('clamps drive and validates oversample on a distortion', () => {
        const dist = normalizeEffect(
            { kind: 'distortion', drive: 7, oversample: '8x' },
        ) as Extract<SoundEffect, { kind: 'distortion' }>;
        expect(dist.drive).toBe(1);
        expect(dist.oversample).toBe('2x');
    });

    it('falls back on an enum value it does not recognise', () => {
        const filter = normalizeEffect(
            { kind: 'filter', type: 'notch' },
        ) as Extract<SoundEffect, { kind: 'filter' }>;
        expect(filter.type).toBe('lowpass');
    });

    it('substitutes the default for NaN and Infinity rather than propagating them', () => {
        const rev = normalizeEffect(
            { kind: 'reverb', decay: NaN, mix: Infinity },
        ) as Extract<SoundEffect, { kind: 'reverb' }>;
        expect(Number.isFinite(rev.decay)).toBe(true);
        expect(Number.isFinite(rev.mix)).toBe(true);
    });
});

describe('normalizeEffects', () => {
    it('preserves order, which is the only meaning the array carries', () => {
        const out = normalizeEffects([{ kind: 'reverb' }, { kind: 'filter' }, { kind: 'compressor' }]);
        expect(out.map(e => e.kind)).toEqual(['reverb', 'filter', 'compressor']);
    });

    it('drops unreadable entries and closes the gap, leaving the survivors in order', () => {
        const out = normalizeEffects([{ kind: 'filter' }, { kind: 'wormhole' }, null, { kind: 'delay' }]);
        expect(out.map(e => e.kind)).toEqual(['filter', 'delay']);
    });

    it('reads a non-array as an empty rack', () => {
        expect(normalizeEffects(undefined)).toEqual([]);
        expect(normalizeEffects({ kind: 'filter' })).toEqual([]);
    });
});

describe('clampSettings', () => {
    const base = (over: Partial<SoundSettings> = {}): SoundSettings =>
        ({ ...DEFAULT_SOUND_SETTINGS, ...over });

    it('leaves already-legal settings alone', () => {
        expect(clampSettings(base())).toEqual({ ...DEFAULT_SOUND_SETTINGS, effects: [] });
    });

    it('clamps volume, rate and pan', () => {
        const s = clampSettings(base({ volume: 5, rate: 100, pan: -9 }));
        expect(s.volume).toBe(1);
        expect(s.rate).toBe(4);
        expect(s.pan).toBe(-1);
    });

    it('zeroes a loop region that ends at or before it starts', () => {
        // Zero reads as "to the end of the file" — the one interpretation that still produces audio.
        expect(clampSettings(base({ loopStart: 3, loopEnd: 1 })).loopEnd).toBe(0);
        expect(clampSettings(base({ loopStart: 2, loopEnd: 2 })).loopEnd).toBe(0);
        expect(clampSettings(base({ loopStart: 1, loopEnd: 4 })).loopEnd).toBe(4);
    });

    it('falls back to a known bus', () => {
        expect(clampSettings(base({ bus: 'reverb-send' as never })).bus).toBe('sfx');
        for (const bus of BUS_IDS) expect(clampSettings(base({ bus })).bus).toBe(bus);
    });
});

describe('parseSoundSettings', () => {
    it('reads junk, undefined and a partial record as a complete settings object', () => {
        for (const raw of [undefined, null, 42, 'nope', {}]) {
            const s = parseSoundSettings(raw);
            expect(s.volume).toBe(DEFAULT_SOUND_SETTINGS.volume);
            expect(s.bus).toBe(DEFAULT_SOUND_SETTINGS.bus);
            expect(s.effects).toEqual([]);
        }
    });

    it('round-trips a fully authored record unchanged', () => {
        const authored: SoundSettings = {
            volume: 0.4, rate: 1.5, pan: -0.25, loop: true, loopStart: 1.5, loopEnd: 3.25,
            fadeIn: 0.2, fadeOut: 0.5, bus: 'music', preload: false,
            effects: [defaultEffect('filter'), { ...defaultEffect('reverb'), enabled: false }],
        };
        expect(parseSoundSettings(JSON.parse(JSON.stringify(authored)))).toEqual(authored);
    });

    it('treats a missing `preload` as true but honours an explicit false', () => {
        expect(parseSoundSettings({}).preload).toBe(true);
        expect(parseSoundSettings({ preload: false }).preload).toBe(false);
    });
});

describe('rackShapeOf', () => {
    it('is equal for param-only edits, so a slider drag retunes instead of rebuilding', () => {
        const a: SoundEffect[] = [defaultEffect('filter')];
        const b: SoundEffect[] = [{ ...defaultEffect('filter'), frequency: 800, q: 4 }];
        expect(rackShapeOf(a)).toBe(rackShapeOf(b));
    });

    it('differs when order, membership or enablement changes', () => {
        const filter = defaultEffect('filter');
        const reverb = defaultEffect('reverb');
        expect(rackShapeOf([filter, reverb])).not.toBe(rackShapeOf([reverb, filter]));
        expect(rackShapeOf([filter])).not.toBe(rackShapeOf([filter, reverb]));
        expect(rackShapeOf([filter])).not.toBe(rackShapeOf([{ ...filter, enabled: false }]));
    });
});

describe('parseSpatialSettings', () => {
    it('defaults an absent record', () => {
        expect(parseSpatialSettings(undefined)).toEqual(DEFAULT_SPATIAL_SETTINGS);
    });

    it('never lets maxDistance sit at or below refDistance', () => {
        // `linear` divides by (max - ref); equal values would be a divide by zero and a negative gain.
        const s = parseSpatialSettings({ refDistance: 10, maxDistance: 2 });
        expect(s.maxDistance).toBeGreaterThan(s.refDistance);
    });

    it('keeps refDistance strictly positive', () => {
        expect(parseSpatialSettings({ refDistance: 0 }).refDistance).toBeGreaterThan(0);
        expect(parseSpatialSettings({ refDistance: -5 }).refDistance).toBeGreaterThan(0);
    });
});
