import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Scene } from '../src/core/scene/scene';
import { Camera } from '../src/core/camera';
import { CameraNode } from '../src/core/scene/nodes/cameraNode';
import { WeatherNode } from '../src/core/scene/nodes/weatherNode';
import { WindNode } from '../src/core/scene/nodes/windNode';
import { precipitationSystem, PRECIPITATION_DEFAULTS, type PrecipitationStyle } from '../src/particles/precipitation';
import {
    BUILTIN_RAIN_SPRITE, BUILTIN_SNOW_SPRITE, SPRITE_BORDER, builtinSpriteSheet, isBuiltinTextureId,
} from '../src/particles/precipitationSprites';
import { activeModule, cloneParticleSystem, parseParticleSystem, particleSystemReferences } from '../src/particles/particleSystemAsset';
import { SIM, packEmitter, simStripMask } from '../src/particles/particlePack';
import { particleSimProgram } from '../src/graphics/programVariants';
import { createProgramUsage, usageFromSceneJson } from '../src/graphics/programUsage';

/**
 * A WeatherNode's falling rain and snow: the particle system it falls with (particles/precipitation.ts),
 * the engine's own sprites (particles/precipitationSprites.ts), the `weather` module, and the scene's
 * rig that keeps one system per kind round the camera (core/scene/precipitationRig.ts).
 */

const look = (patch: Partial<PrecipitationStyle> = {}): PrecipitationStyle => ({ rate: 1, size: 1, speed: 1, sprite: null, ...patch });
const env = { wind: [0, 0] as [number, number], density: 1, prewarm: true };

describe('the precipitation system', () => {
    it('rains: fast straight streaks above the camera, killed by what they hit, at its rate', () => {
        const def = precipitationSystem('rain', look({ rate: 0.5 }), env);
        const e = def.emitters[0];
        const d = PRECIPITATION_DEFAULTS.rain;
        expect(def.emitters.length).toBe(1);
        expect(e.simSpace).toBe('world');
        expect(e.capacity).toBe(d.capacity);
        expect(activeModule(e, 'spawnRate')!.params.rate).toBe(d.spawnRate * 0.5);
        expect(activeModule(e, 'shape')!.params).toMatchObject({ shape: 'box', box: [36, 1, 36], offset: [0, 12, 0] });
        const v = activeModule(e, 'velocity')!.params;
        expect(v.direction).toEqual([0, -8.5, 0]);
        expect(v.speed[0]).toBeCloseTo(8.5 * 0.88);
        // A drop at terminal velocity: no force at all, no gravity (a game's gravity is not the rain's).
        expect(activeModule(e, 'gravity')).toBeUndefined();
        expect(activeModule(e, 'wind')).toBeUndefined();
        expect(activeModule(e, 'collision')!.params).toMatchObject({ depth: true, kill: true, bodies: false });
        expect(activeModule(e, 'weather')!.params).toEqual({ kind: 'rain', shelter: true, fullRate: 0.5 });
        expect(e.render).toMatchObject({ alignment: 'velocity', blend: 'alpha', lit: true, textureId: BUILTIN_RAIN_SPRITE });
        expect(e.render.flipbook).toMatchObject({ columns: 4, rows: 1, frames: 4, mode: 'fps', fps: 0, randomStart: true, blend: false });
        expect(e.render.nearFade).toBeGreaterThan(0);
        expect(def.lod.enabled).toBe(false);
    });

    it('is matte and translucent: no highlight, light through the drop like a leaf', () => {
        for (const kind of ['rain', 'snow'] as const) {
            const render = precipitationSystem(kind, look(), env).emitters[0].render;
            // Roughness 1, no metal, no maps: the non-PBR half-Lambert branch, which has no GGX highlight.
            expect([render.roughness, render.metallic, render.normalTextureId, render.ormTextureId]).toEqual([1, 0, null, null]);
            expect(render.translucency).toBeGreaterThan(0);
        }
    });

    it('draws each streak between a min and a max trail, rain only, clamped and ordered', () => {
        const range = (trail?: [number, number]) => precipitationSystem('rain', look({ trail }), env).emitters[0].render.stretchRange;
        expect(range()).toEqual([0.7, 1.3]);
        expect(range([2, 3])).toEqual([2, 3]);
        expect(range([3, 2])).toEqual([2, 3]);
        expect(range([0, 99])).toEqual([0.1, 4]);
        expect(precipitationSystem('snow', look({ trail: [2, 3] }), env).emitters[0].render.stretchRange).toEqual([1, 1]);
        const packed = packEmitter(precipitationSystem('rain', look({ trail: [0.5, 1.5] }), env).emitters[0]);
        expect(packed.draw.u_stretchRange).toEqual([0.5, 1.5, 0, 0]);
    });

    it('snows: slow, fluttering, spinning flakes pulled to their fall in the wind', () => {
        const def = precipitationSystem('snow', look(), { ...env, wind: [3, -2] });
        const e = def.emitters[0];
        expect(activeModule(e, 'wind')!.params).toMatchObject({ velocity: [3, -1, -2], influence: PRECIPITATION_DEFAULTS.snow.coupling });
        expect(activeModule(e, 'curlNoise')).toBeDefined();
        expect(activeModule(e, 'rotation')!.params.spin).toEqual([-60, 60]);
        expect(activeModule(e, 'weather')!.params.kind).toBe('snow');
        expect(e.render).toMatchObject({ alignment: 'camera', textureId: BUILTIN_SNOW_SPRITE });
        expect(e.render.flipbook).toMatchObject({ columns: 4, rows: 2, frames: 8 });
    });

    it('scales by size and speed: a faster fall is a shorter life over the same column', () => {
        const slow = precipitationSystem('rain', look(), env).emitters[0];
        const fast = precipitationSystem('rain', look({ speed: 2, size: 2 }), env).emitters[0];
        expect(activeModule(fast, 'velocity')!.params.direction[1]).toBe(-17);
        expect(activeModule(fast, 'lifetime')!.params.range[0]).toBeCloseTo(activeModule(slow, 'lifetime')!.params.range[0] / 2);
        expect(activeModule(fast, 'size')!.params.range[1]).toBeCloseTo(activeModule(slow, 'size')!.params.range[1] * 2);
    });

    it('draws a sprite sheet when given one: a random still cell each, or playing at its rate', () => {
        const still = precipitationSystem('snow', look({ sprite: { textureId: 'flakes', columns: 3, rows: 2, frames: 5, fps: 0 } }), env).emitters[0];
        expect(still.render.textureId).toBe('flakes');
        expect(still.render.flipbook).toMatchObject({ columns: 3, rows: 2, frames: 5, fps: 0, randomStart: true, blend: false });
        const played = precipitationSystem('snow', look({ sprite: { textureId: 'flakes', columns: 3, rows: 2, frames: 6, fps: 12 } }), env).emitters[0];
        expect(played.render.flipbook).toMatchObject({ mode: 'fps', fps: 12, blend: true });
    });

    it('survives the asset parser whole, the weather module included', () => {
        const def = precipitationSystem('rain', look({ rate: 0.25 }), env);
        const back = parseParticleSystem(cloneParticleSystem(def));
        expect(back).toEqual(def);
    });

    it('packs the weather module as a runtime bit, never a strip variant', () => {
        const rain = packEmitter(precipitationSystem('rain', look({ rate: 0.5 }), env).emitters[0]);
        expect(rain.simMask & SIM.WEATHER).toBeTruthy();
        expect(rain.sim.u_precipSim).toEqual([0, 1, 2, 0]);
        const snow = packEmitter(precipitationSystem('snow', look(), env).emitters[0]);
        expect(snow.sim.u_precipSim).toEqual([1, 1, 1, 0]);
        // Rain needs no noise, fields or parent; snow needs its turbulence.
        expect(particleSimProgram(simStripMask(rain.simMask, false))).toBe('particleSim~s11');
        expect(particleSimProgram(simStripMask(snow.simMask, false))).toBe('particleSim~s10');
        // An emitter without the module: inert values.
        const plain = precipitationSystem('rain', look(), env).emitters[0];
        plain.update = plain.update.filter(m => m.type !== 'weather');
        const packed = packEmitter(plain);
        expect(packed.simMask & SIM.WEATHER).toBe(0);
        expect(packed.sim.u_precipSim).toEqual([0, 0, 1, 0]);
    });

    it('mirrors every SIM bit in the simulation core', () => {
        const core = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'particleSimCore.wgsl'), 'utf-8');
        for (const [key, bit] of Object.entries(SIM)) {
            const m = new RegExp(`const SIM_${key}: u32\\s*= (\\d+)u;`).exec(core);
            expect(m, `SIM_${key}`).not.toBeNull();
            expect(Number(m![1]), `SIM_${key}`).toBe(bit);
        }
    });

    it('ships its programs with a published game whose weather makes it fall', () => {
        const use = createProgramUsage();
        usageFromSceneJson({ type: 'node', children: [
            { type: 'weather', weather: { precipitation: 'rain', precipitationRate: 0.6 } },
            { type: 'weather', weather: { precipitation: 'snow', precipitationRate: 0.6 } },
        ] }, use);
        for (const name of ['particleSim~s11', 'particleSim~s10', 'particleBillboard']) expect(use.names.has(name), name).toBe(true);
        const dry = createProgramUsage();
        usageFromSceneJson({ type: 'weather', weather: { wetness: 1 } }, dry);
        expect(dry.names.has('particleBillboard')).toBe(false);
    });
});

describe('the built-in sprites', () => {
    it('are white sheets whose shape is the alpha, every cell inked inside its transparent border', () => {
        for (const id of [BUILTIN_RAIN_SPRITE, BUILTIN_SNOW_SPRITE]) {
            const sheet = builtinSpriteSheet(id)!;
            expect(sheet.pixels.length).toBe(sheet.width * sheet.height * 4);
            const cellW = sheet.width / sheet.columns, cellH = sheet.height / sheet.rows;
            let tinted = 0;
            for (let i = 0; i < sheet.pixels.length; i += 4)
                if (sheet.pixels[i] + sheet.pixels[i + 1] + sheet.pixels[i + 2] !== 765) tinted++;
            expect(tinted, id).toBe(0);
            for (let cell = 0; cell < sheet.frames; cell++) {
                const ox = (cell % sheet.columns) * cellW, oy = Math.floor(cell / sheet.columns) * cellH;
                let inked = 0, border = 0;
                for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) {
                    const a = sheet.pixels[((oy + y) * sheet.width + ox + x) * 4 + 3];
                    const edge = x < SPRITE_BORDER || y < SPRITE_BORDER || x >= cellW - SPRITE_BORDER || y >= cellH - SPRITE_BORDER;
                    if (edge) border = Math.max(border, a);
                    else if (a > 128) inked++;
                }
                expect(border, `${id} cell ${cell} border`).toBe(0);
                expect(inked, `${id} cell ${cell}`).toBeGreaterThan(20);
            }
        }
    });

    it('are the same every run, and not assets', () => {
        const a = builtinSpriteSheet(BUILTIN_SNOW_SPRITE)!.pixels;
        expect(Array.from(a.subarray(0, 4096))).toEqual(Array.from(builtinSpriteSheet(BUILTIN_SNOW_SPRITE)!.pixels.subarray(0, 4096)));
        expect(builtinSpriteSheet('rain')).toBeNull();
        expect(isBuiltinTextureId(BUILTIN_RAIN_SPRITE)).toBe(true);
        expect(isBuiltinTextureId('my-texture')).toBe(false);
        expect(particleSystemReferences(precipitationSystem('rain', look(), env)).textures).toEqual([]);
        expect(particleSystemReferences(precipitationSystem('rain', look({ sprite: { textureId: 'drops', columns: 1, rows: 1, frames: 1, fps: 0 } }), env)).textures)
            .toEqual(['drops']);
    });
});

describe("the scene's precipitation", () => {
    const setup = (at: [number, number, number] = [0, 2, 0]) => {
        const scene = new Scene();
        const camera = new CameraNode('camera', new Camera({}));
        camera.setPosition(at);
        scene.addNode(camera);
        return { scene, camera };
    };
    const step = (scene: Scene, frames = 1) => {
        for (let i = 0; i < frames; i++) { scene.root.updateTransforms(); scene.precipitation.update(1 / 60, i / 60); }
    };

    it('is nothing while nothing falls', () => {
        const { scene } = setup();
        scene.addNode(new WeatherNode('wet', { wetness: 1 }));
        step(scene);
        expect(scene.precipitation.systems).toEqual([]);
    });

    it('runs one rain system round the camera, outside the tree and the save', async () => {
        const { scene } = setup([5, 2, -3]);
        scene.addNode(new WeatherNode('rain', { precipitation: 'rain', precipitationRate: 0.6 }));
        step(scene);
        const rain = scene.precipitation.systemOf('rain')!;
        expect(scene.precipitation.systems).toEqual([rain]);
        expect(rain.scene).toBe(scene);
        expect(rain.isEditorOwned).toBe(true);
        expect(rain.isPlaying).toBe(true);
        expect([...scene.particleSystems]).not.toContain(rain);
        expect(rain.parent).toBeNull();
        // It sits on the camera, and its bounds hold the camera (never culled).
        expect(Array.from(rain.worldPosition)).toEqual([5, 2, -3]);
        const b = rain.getBoundingBox();
        expect(b.min[1]).toBeLessThan(2);
        expect(b.max[1]).toBeGreaterThan(2 + PRECIPITATION_DEFAULTS.rain.height);
        const json = JSON.stringify(await scene.root.serialize());
        expect(json).not.toContain('__precipitation__');
    });

    it('spawns at the highest rate in reach, in the look of the highest-priority volume', () => {
        const { scene } = setup();
        scene.addNode(new WeatherNode('light', { precipitation: 'rain', precipitationRate: 0.3, precipitationSize: 2, priority: 2 }));
        scene.addNode(new WeatherNode('heavy', { precipitation: 'rain', precipitationRate: 0.9, precipitationSize: 0.5 }));
        step(scene);
        const e = scene.precipitation.systemOf('rain')!.system.emitters[0];
        expect(activeModule(e, 'weather')!.params.fullRate).toBeCloseTo(Math.ceil(0.9 * 64) / 64);
        expect(activeModule(e, 'size')!.params.range[0]).toBeCloseTo(PRECIPITATION_DEFAULTS.rain.size[0] * 2);
    });

    it('ignores a box out of reach of its column, and runs both kinds where both fall', () => {
        const { scene } = setup();
        const far = new WeatherNode('far', { precipitation: 'snow', precipitationRate: 1, size: [10, 10, 10] });
        far.setPosition([500, 0, 0]);
        scene.addNode(far);
        scene.addNode(new WeatherNode('rain', { precipitation: 'rain', precipitationRate: 1 }));
        step(scene);
        expect(scene.precipitation.systemOf('snow')).toBeNull();
        scene.addNode(new WeatherNode('snow', { precipitation: 'snow', precipitationRate: 0.5 }));
        step(scene);
        expect(scene.precipitation.systems.length).toBe(2);
    });

    it('stops emitting when the rain stops, and the density scales what spawns', () => {
        const { scene } = setup();
        const w = new WeatherNode('rain', { precipitation: 'rain', precipitationRate: 1 });
        scene.addNode(w);
        scene.precipitation.density = 0.4;
        step(scene);
        const rain = scene.precipitation.systemOf('rain')!;
        expect(rain.spawnRateScale).toBeCloseTo(0.4);
        w.precipitationRate = 0;
        step(scene);
        expect(rain.runtime.emitters.every(e => e.state !== 'playing')).toBe(true);
        w.precipitationRate = 1;
        step(scene);
        expect(rain.runtime.emitters.every(e => e.state === 'playing')).toBe(true);
    });

    it('takes the trail range of the volume it looks like, and rebuilds when it changes', () => {
        const { scene } = setup();
        const w = new WeatherNode('rain', { precipitation: 'rain', precipitationRate: 1, precipitationTrailMin: 2, precipitationTrailMax: 3 });
        scene.addNode(w);
        step(scene);
        const rain = scene.precipitation.systemOf('rain')!;
        expect(rain.system.emitters[0].render.stretchRange).toEqual([2, 3]);
        w.precipitationTrailMax = 0.5;
        expect([w.precipitationTrailMin, w.precipitationTrailMax]).toEqual([0.5, 0.5]);
        step(scene);
        expect(rain.system.emitters[0].render.stretchRange).toEqual([0.5, 0.5]);
    });

    it('slants with the scene wind, as much as the volume asks', () => {
        const { scene } = setup();
        scene.addNode(new WindNode('wind', { direction: 0, strength: 1 }));
        scene.addNode(new WeatherNode('rain', { precipitation: 'rain', precipitationRate: 1, precipitationWind: 0.5 }));
        step(scene);
        const dir = activeModule(scene.precipitation.systemOf('rain')!.system.emitters[0], 'velocity')!.params.direction;
        expect(dir[0]).toBeCloseTo(3.5);
        expect(dir[2]).toBeCloseTo(0);
    });

    it('falls for no orthographic camera, and lets go of its systems with the scene', () => {
        const { scene, camera } = setup();
        scene.addNode(new WeatherNode('rain', { precipitation: 'rain', precipitationRate: 1 }));
        camera.camera.type = 'orthographic';
        step(scene);
        expect(scene.precipitation.systemOf('rain')).toBeNull();
        camera.camera.type = 'perspective';
        step(scene);
        const rain = scene.precipitation.systemOf('rain')!;
        scene.precipitation.dispose();
        expect(rain.scene).toBeNull();
        expect(scene.precipitation.systems).toEqual([]);
    });

    it('keeps the clock the ground animates by, wrapped', () => {
        const { scene } = setup();
        const before = scene.precipitation.clock;
        scene.precipitation.update(0.5, 0);
        expect(scene.precipitation.clock).toBeCloseTo(before + 0.5);
        scene.precipitation.update(5000, 0);
        expect(scene.precipitation.clock).toBeLessThan(4096);
    });
});
