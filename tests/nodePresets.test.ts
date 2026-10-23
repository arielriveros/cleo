import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyPreset, type Preset } from '../src/core/presets';
import { WindNode } from '../src/core/scene/nodes/windNode';
import { WaterVolumeNode } from '../src/core/scene/nodes/waterVolumeNode';
import { ForceFieldNode } from '../src/core/scene/nodes/forceFieldNode';
import { SkyAtmosphereNode } from '../src/core/scene/nodes/skyAtmosphereNode';
import { CameraRigNode } from '../src/core/scene/nodes/cameraRigNode';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { SoundNode } from '../src/core/scene/nodes/soundNode';
import { VolumetricCloudsNode } from '../src/core/scene/nodes/volumetricCloudsNode';
import { WIND_PRESETS } from '../src/core/scene/nodes/windPresets';
import { WATER_VOLUME_PRESETS } from '../src/core/scene/nodes/waterVolumePresets';
import { FORCE_FIELD_PRESETS } from '../src/core/scene/nodes/forceFieldPresets';
import { SKY_ATMOSPHERE_PRESETS } from '../src/core/scene/nodes/skyAtmospherePresets';
import { CAMERA_RIG_PRESETS } from '../src/core/scene/nodes/cameraRigPresets';
import { CHARACTER_PRESETS } from '../src/core/scene/nodes/characterPresets';
import { PERCEPTION_PRESETS, FLOCKING_PRESETS } from '../src/core/scene/nodes/controllerPresets';
import { SOUND_FALLOFF_PRESETS } from '../src/core/scene/nodes/soundPresets';
import { DirectionalLight, PointLight, Spotlight } from '../src/graphics/lighting';
import {
    DIRECTIONAL_LIGHT_PRESETS, POINT_LIGHT_PRESETS, SPOT_LIGHT_PRESETS, lightPresetsFor,
} from '../src/graphics/lightPresets';
import { kelvinToRgb } from '../src/graphics/colorTemperature';
import { PHYSICS_SURFACE_PRESETS } from '../src/physics/surfacePresets';
import { AUTO_EXPOSURE_PRESETS, LENS_LOOK_PRESETS, DOF_PRESETS } from '../src/graphics/renderPresets';
import { Renderer, QUALITY_TIERS } from '../src/graphics/renderer';
import { perceptionTuning } from '../src/ai/perception';

// Every preset table, guarded the same way: ids unique, every key a real field of its target, no key the
// table promised to leave alone, and — the strong one — what a preset says is what the target ends up
// holding, so no value is silently clamped by a setter or lost to an assignment-order trap.

type AnyPreset = Preset<object>;

interface Case {
    name: string;
    table: readonly AnyPreset[];
    make: () => object;
    /** Fields this table must never set. */
    reserved: string[];
}

const QUALITY_KEYS = Object.keys(QUALITY_TIERS.high);

const CASES: Case[] = [
    { name: 'wind', table: WIND_PRESETS, make: () => new WindNode('wind'),
      reserved: ['direction', 'fadeStart', 'fadeEnd'] },
    { name: 'water', table: WATER_VOLUME_PRESETS, make: () => new WaterVolumeNode('water'),
      reserved: ['size', 'surfaceNodeId', 'splashTemplate', 'enabled', 'affectCharacters'] },
    { name: 'forceField', table: FORCE_FIELD_PRESETS, make: () => new ForceFieldNode('field'),
      reserved: ['radius', 'extents', 'enabled'] },
    { name: 'sky', table: SKY_ATMOSPHERE_PRESETS, make: () => new SkyAtmosphereNode('sky'),
      reserved: ['useSceneSun', 'sunDirection', 'sunColor', 'sunIntensity', 'sunDiskSize', 'planetRadius',
          'atmosphereRadius', 'resolution', 'viewSteps', 'lightSteps', 'fogHeight', 'godRaysEnabled',
          'nightEnabled', 'moonEnabled', 'moonlightIntensity'] },
    { name: 'cameraRig', table: CAMERA_RIG_PRESETS, make: () => new CameraRigNode('rig'),
      reserved: ['followId', 'lookAtId', 'cameraNodeId', 'collisionIgnoreIds', 'invertPitch',
          'yawSensitivity', 'pitchSensitivity', 'shakeFrequency', 'shakeDecay', 'shakeSustained'] },
    { name: 'character', table: CHARACTER_PRESETS, make: () => new CharacterNode('pawn'),
      reserved: ['driveWhenUnpossessed'] },
    { name: 'flocking', table: FLOCKING_PRESETS, make: () => new ControllerNode('brain'), reserved: [] },
    { name: 'perception', table: PERCEPTION_PRESETS, make: () => ({ ...new ControllerNode('brain').perception }),
      reserved: [] },
    { name: 'soundFalloff', table: SOUND_FALLOFF_PRESETS, make: () => new SoundNode('sound'),
      reserved: ['mode', 'volume', 'loopMode', 'playOnStart', 'sampleId'] },
    { name: 'directionalLight', table: DIRECTIONAL_LIGHT_PRESETS, make: () => new DirectionalLight({}), reserved: [] },
    { name: 'pointLight', table: POINT_LIGHT_PRESETS, make: () => new PointLight({}), reserved: [] },
    { name: 'spotLight', table: SPOT_LIGHT_PRESETS, make: () => new Spotlight({}), reserved: [] },
    { name: 'surface', table: PHYSICS_SURFACE_PRESETS, make: () => ({ friction: 0.3, restitution: 0 }), reserved: [] },
];

function expectHolds(target: any, options: object, label: string): void {
    for (const [k, v] of Object.entries(options)) {
        const got = target[k];
        if (Array.isArray(v)) {
            expect(got.length, `${label}.${k}`).toBe(v.length);
            v.forEach((x: number, i: number) => expect(got[i], `${label}.${k}[${i}]`).toBeCloseTo(x, 4));
        } else if (typeof v === 'number' && Number.isFinite(v)) {
            expect(got, `${label}.${k}`).toBeCloseTo(v, 4);
        } else {
            expect(got, `${label}.${k}`).toEqual(v);
        }
    }
}

describe('preset tables', () => {
    for (const c of CASES) {
        describe(c.name, () => {
            it('has unique ids', () => {
                const ids = c.table.map(p => p.id);
                expect(new Set(ids).size).toBe(ids.length);
            });

            it('only sets real fields, never reserved ones', () => {
                const target = c.make();
                for (const p of c.table)
                    for (const k of Object.keys(p.options)) {
                        expect(k in target, `${p.id}.${k}`).toBe(true);
                        expect(c.reserved, `${p.id}.${k}`).not.toContain(k);
                    }
            });

            it('leaves every target holding exactly what each preset says, whatever came before', () => {
                const target = c.make();
                // Applied in sequence on ONE target, so a value surviving from the previous preset — or a
                // setter clamping against one — shows up as a mismatch.
                for (const p of c.table) {
                    expect(applyPreset(target, c.table, p)).toBe(true);
                    expectHolds(target, p.options, `${c.name}/${p.id}`);
                }
                for (const p of [...c.table].reverse()) {
                    applyPreset(target, c.table, p);
                    expectHolds(target, p.options, `${c.name}/${p.id} (reverse)`);
                }
            });
        });
    }

    it('perception presets pass the tolerant reader unchanged', () => {
        for (const p of PERCEPTION_PRESETS) expect(perceptionTuning(p.options)).toEqual(p.options);
    });

    it('camera rig locked styles end inside their own limits', () => {
        const rig = new CameraRigNode('rig');
        rig.yaw = 170;
        rig.applyPreset('isometric');
        expect(rig.yaw).toBe(45);
        expect(rig.pitch).toBe(35);
        rig.applyPreset('thirdPerson');
        expect(rig.yawMin).toBe(-Infinity);
        expect(rig.yawMax).toBe(Infinity);
    });

    it('a light preset re-authors a legacy light in real units', () => {
        const light = new PointLight({ diffuse: [3, 3, 3], constant: 1, linear: 0.09, quadratic: 0.032 } as any);
        expect(light.legacyFalloff).toBe(true);
        applyPreset(light, POINT_LIGHT_PRESETS, 'bulb60');
        expect(light.legacyFalloff).toBe(false);
        expect(light.intensity).toBe(800);
    });

    it('picks the light table by type', () => {
        expect(lightPresetsFor(new DirectionalLight({}))).toBe(DIRECTIONAL_LIGHT_PRESETS);
        expect(lightPresetsFor(new Spotlight({}))).toBe(SPOT_LIGHT_PRESETS);
        expect(lightPresetsFor(new PointLight({}))).toBe(POINT_LIGHT_PRESETS);
    });

    it('every spot preset keeps its outer cone outside the inner one', () => {
        for (const p of SPOT_LIGHT_PRESETS) expect(p.options.outerCutOff!).toBeGreaterThan(p.options.cutOff!);
    });

    it('node applyPreset methods resolve ids and reject unknown ones', () => {
        const wind = new WindNode('wind', { direction: 123 });
        expect(wind.applyPreset('storm')).toBe(true);
        expect(wind.strength).toBe(2);
        expect(wind.direction).toBe(123);
        expect(new WaterVolumeNode('w').applyPreset('nope')).toBe(false);
        expect(new ForceFieldNode('f').applyPreset('explosion')).toBe(true);
        expect(new SkyAtmosphereNode('s').applyPreset('denseFog')).toBe(true);
        expect(new CharacterNode('c').applyPreset('platformer')).toBe(true);
    });
});

describe('kelvinToRgb', () => {
    it('normalises the brightest channel to 1', () => {
        for (const k of [1000, 1850, 2700, 4000, 6500, 9000, 20000])
            expect(Math.max(...kelvinToRgb(k))).toBeCloseTo(1, 6);
    });

    it('is red-heavy when warm and blue-heavy when cool', () => {
        const warm = kelvinToRgb(1900), cool = kelvinToRgb(9000);
        expect(warm[0]).toBe(1);
        expect(warm[2]).toBeLessThan(0.4);
        expect(cool[2]).toBe(1);
        expect(cool[0]).toBeLessThan(0.9);
    });
});

describe('render presets', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    const makeRenderer = () => {
        vi.stubGlobal('document', { createElement: () => ({ getContext: () => null, style: {} }) });
        return new Renderer({});
    };

    const tables: [string, readonly AnyPreset[]][] = [
        ['exposure', AUTO_EXPOSURE_PRESETS], ['look', LENS_LOOK_PRESETS], ['dof', DOF_PRESETS],
    ];
    // What a look must never touch: the quality tiers' fields, and the choices that are the author's.
    const reserved = [...QUALITY_KEYS, 'toneMapper', 'colorGradingLut', 'colorGradingIntensity', 'bloomMaskEnabled',
        'lensDirtTexture', 'dofFocusDistance', 'exposure', 'quality'];

    for (const [name, table] of tables) {
        it(`${name}: unique ids, setter-backed keys, nothing reserved`, () => {
            const ids = table.map(p => p.id);
            expect(new Set(ids).size).toBe(ids.length);
            for (const p of table)
                for (const k of Object.keys(p.options)) {
                    expect(Object.getOwnPropertyDescriptor(Renderer.prototype, k)?.set, `${p.id}.${k}`).toBeTypeOf('function');
                    expect(reserved, `${p.id}.${k}`).not.toContain(k);
                }
        });

        it(`${name}: the renderer ends up holding what each preset says`, () => {
            const renderer = makeRenderer();
            for (const p of [...table, ...[...table].reverse()]) {
                applyPreset(renderer, table, p);
                expectHolds(renderer, p.options, `${name}/${p.id}`);
            }
        });
    }

    it('a fixed exposure switches metering off before writing the EV', () => {
        const renderer = makeRenderer();
        applyPreset(renderer, AUTO_EXPOSURE_PRESETS, 'litInterior');
        expect(renderer.autoExposureEnabled).toBe(false);
        expect(renderer.ev100).toBeCloseTo(7, 4);
        applyPreset(renderer, AUTO_EXPOSURE_PRESETS, 'default');
        expect(renderer.autoExposureEnabled).toBe(true);
        expect(renderer.exposureCompensation).toBe(1);
    });
});

describe('clouds follow the scene wind', () => {
    const out: [number, number, number] = [0, 0, 0];

    it('blows the Wind node’s way at windSpeed × its strength', () => {
        const clouds = new VolumetricCloudsNode('clouds', { windSpeed: 10, windDirection: [1, 0, 0] });
        const wind = new WindNode('wind', { direction: 90, strength: 1.5 });
        const speed = clouds.resolveWind(wind, out);
        expect(speed).toBeCloseTo(15);
        // 90 degrees counter-clockwise from +X is -Z (see WindNode.directionXZ).
        expect(out[0]).toBeCloseTo(0);
        expect(out[1]).toBe(0);
        expect(out[2]).toBeCloseTo(-1);
    });

    it('a calm wind stills the sky', () => {
        const clouds = new VolumetricCloudsNode('clouds', { windSpeed: 10 });
        expect(clouds.resolveWind(new WindNode('wind', { strength: 0 }), out)).toBe(0);
    });

    it('falls back to its own wind with no Wind node, a hidden one, or following switched off', () => {
        const own: [number, number, number] = [0.6, 0, 0.8];
        const clouds = new VolumetricCloudsNode('clouds', { windSpeed: 7, windDirection: own });
        expect(clouds.resolveWind(null, out)).toBe(7);
        expect(out).toEqual(own);

        const hidden = new WindNode('wind', { direction: 0 });
        hidden.visible = false;
        expect(clouds.resolveWind(hidden, out)).toBe(7);
        expect(out).toEqual(own);

        clouds.useSceneWind = false;
        expect(clouds.resolveWind(new WindNode('wind', { direction: 0, strength: 2 }), out)).toBe(7);
        expect(out).toEqual(own);
    });

    it('follows by default, saves the choice, and a cloud preset never changes it', () => {
        expect(new VolumetricCloudsNode('clouds').useSceneWind).toBe(true);
        const clouds = new VolumetricCloudsNode('clouds', { useSceneWind: false });
        const json = (clouds as any)._serializePayload().clouds;
        expect(json.useSceneWind).toBe(false);
        expect(new VolumetricCloudsNode('again', json).useSceneWind).toBe(false);
        clouds.applyPreset('stormy');
        expect(clouds.useSceneWind).toBe(false);
    });
});
