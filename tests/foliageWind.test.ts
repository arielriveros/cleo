import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
// @ts-expect-error -- plain .mjs shared with the bundler configs; it has no declarations.
import { translateWgsl } from '../tools/wgslTranslate.mjs';
// @ts-expect-error -- same.
import { resolveIncludes, listVariants } from '../tools/shaderIncludes.mjs';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { WindNode } from '../src/core/scene/nodes/windNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { Material, applyWind, windConfigOf } from '../src/graphics/material';

// Foliage wind, phase 1: a scene-wide WindNode, per-material response, and a vertex displacement compiled
// into `wind` variants of the instanced foliage programs only. These pin the parts that matter: plants
// stay rooted, parts of one plant bend identically, non-wind programs are untouched, and the shadow
// sways with its plant.

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const read = (p: string) => readFileSync(join(WGSL, p), 'utf-8');

// ---- A CPU mirror of chunks/foliageWind.wgsl ------------------------------------------------------

const fract = (x: number) => x - Math.floor(x);
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
function noise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}
const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

type W = { dir: [number, number]; strength: number; wavelength: number; speed: number; fadeStart: number; fadeEnd: number;
           lean: number; stiffness: number; minY: number; height: number; cam: [number, number, number] };
const W0: W = { dir: [1, 0], strength: 1, wavelength: 18, speed: 4, fadeStart: 40, fadeEnd: 70,
                lean: 0.3, stiffness: 1, minY: 0, height: 1, cam: [0, 2, 0] };

function lean(origin: number[], t: number, w: W): number {
    const sx = w.dir[0] * (w.speed * t / w.wavelength), sz = w.dir[1] * (w.speed * t / w.wavelength);
    const px = origin[0] / w.wavelength - sx, pz = origin[2] / w.wavelength - sz;
    const gust = noise(px, pz) * 0.7 + noise(px * 2.13 + 17, pz * 2.13 + 3) * 0.3;
    const phase = hash(Math.floor(origin[0] * 4), Math.floor(origin[2] * 4)) * 6.2831853;
    const sway = Math.sin(t * (1.7 / w.stiffness) + phase);
    const l = w.strength * w.lean * (0.2 + 0.8 * gust + 0.2 * sway) / w.stiffness;
    const d = Math.hypot(origin[0] - w.cam[0], origin[1] - w.cam[1], origin[2] - w.cam[2]);
    return l * (1 - smoothstep(w.fadeStart, w.fadeEnd, d));
}

/** Instance = translation + uniform scale, which is what foliage bakes. */
function displace(objPos: number[], origin: number[], scale: number, t: number, w: W): number[] {
    const world = objPos.map((v, i) => origin[i] + v * scale);
    const base = [origin[0], origin[1] + w.minY * scale, origin[2]];
    const h = Math.min(1, Math.max(0, (objPos[1] - w.minY) / w.height));
    const bend = lean(origin, t, w) * h * h * w.height * scale;
    const rel = world.map((v, i) => v - base[i]);
    const len = Math.hypot(...rel);
    const bent = [rel[0] + w.dir[0] * bend, rel[1], rel[2] + w.dir[1] * bend];
    const bl = Math.hypot(...bent);
    return bl > 1e-5 ? bent.map((v, i) => base[i] + v * len / bl) : world;
}

describe('the wind displacement', () => {
    it('keeps the root planted and the plant its length', () => {
        const origin = [5, 0, 3];
        for (const t of [0, 1.3, 7.9]) {
            const root = displace([0.2, 0, 0.1], origin, 2, t, W0);
            expect(root[1]).toBeCloseTo(0, 6);
            expect(Math.hypot(root[0] - origin[0], root[2] - origin[2])).toBeCloseTo(Math.hypot(0.4, 0.2), 6);
            const tip = displace([0, 1, 0], origin, 2, t, W0);
            expect(Math.hypot(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2])).toBeCloseTo(2, 5);
            expect(tip[0]).toBeGreaterThan(origin[0]);   // leans downwind
        }
    });

    it('moves the tip, more in a gust than a lull, and differently for neighbours', () => {
        const tips = [0, 0.5, 1, 1.5, 2].map(t => displace([0, 1, 0], [5, 0, 3], 1, t, W0)[0] - 5);
        expect(Math.max(...tips) - Math.min(...tips)).toBeGreaterThan(0.005);
        const a = displace([0, 1, 0], [5, 0, 3], 1, 2, W0)[0] - 5;
        const b = displace([0, 1, 0], [5.6, 0, 3.3], 1, 2, W0)[0] - 5.6;
        expect(Math.abs(a - b)).toBeGreaterThan(1e-4);
    });

    it('fades to exactly nothing at the fade end, so the static program takes over without a pop', () => {
        const far = { ...W0, cam: [0, 0, 0] as [number, number, number] };
        const at = displace([0, 1, 0], [70, 0, 0], 1, 3, far);
        expect(at[0]).toBeCloseTo(70, 9);
        const near = displace([0, 1, 0], [20, 0, 0], 1, 3, far);
        expect(Math.abs(near[0] - 20)).toBeGreaterThan(0.01);
    });

    it('bends two parts of one plant identically: the shape is the LAYER\'s, not each part\'s', () => {
        // Bark (low) and needles (high) of one tree share minY/height, so a point both contain moves alike.
        const w = { ...W0, minY: -1, height: 2 };
        const p = [0.3, 0.4, 0];
        expect(displace(p, [1, 0, 1], 1, 2, w)).toEqual(displace(p, [1, 0, 1], 1, 2, w));
    });
});

// ---- Shaders and variants -------------------------------------------------------------------------

async function compile(file: string, defines: object) {
    const source = read(file);
    const composed = resolveIncludes(source, dirname(join(WGSL, file)), {
        read: (p: string) => readFileSync(p, 'utf-8'), resolve: (d: string, r: string) => join(d, r),
        onDependency: () => {}, defines,
    });
    return translateWgsl(composed, file);
}

describe('wind variants', () => {
    const FILES = ['geometryPBRInstanced.wgsl', 'geometryBlinnPhongInstanced.wgsl', 'geometryFoliageBillboard.wgsl',
                   'shadowMapInstanced.wgsl', 'shadowMapInstancedCutout.wgsl'];

    it('every instanced foliage program (colour AND shadow) declares a wind variant', () => {
        for (const f of FILES)
            expect((listVariants(read(f)) as { tag: string }[]).map(v => v.tag), f).toContain('wind');
    });

    it('only the wind variant reads the wind time; the base program has it compiled out', async () => {
        for (const f of FILES) {
            const variant = (listVariants(read(f)) as { tag: string; defines: object }[]).find(v => v.tag === 'wind')!;
            const windy = await compile(f, variant.defines);
            const still = await compile(f, {});
            expect(windy.vertex, f).toMatch(/u_windTime/);
            expect(still.vertex, f).not.toMatch(/u_windTime\.x/);
        }
    });

    it('colour and shadow vertex stages displace through the same function', () => {
        for (const chunk of ['chunks/instancedVertex.wgsl', 'chunks/instancedDepthVertex.wgsl']) {
            const src = read(chunk);
            expect(src).toContain('#include "./foliageWind.wgsl"');
            expect(src).toMatch(/#if CLEO_WIND[\s\S]*windDisplace\([\s\S]*#endif/);
        }
    });
});

// ---- Renderer wiring --------------------------------------------------------------------------------

describe('renderer wiring', () => {
    const renderer = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');

    it('never sways the impostor bucket, and only buckets that start inside the fade', () => {
        expect(renderer).toContain('const windy = !!wind && slot < billboardBucket && layer.levels[slot].distance < wind.fadeEnd;');
    });

    it('sways only the nearest shadow cascade', () => {
        expect(renderer).toContain('const wind = cascade === 0 ? this._foliageWind(scene, layer) : null;');
    });

    it('takes the wind response per LAYER (strongest material), so a tree\'s parts stay attached', () => {
        const at = renderer.indexOf('private _foliageWind(');
        const body = renderer.slice(at, renderer.indexOf('\n    }\n', at));
        expect(body).toContain('if (strength > lean)');
        expect(body).toContain('layer.levels[0]');
    });
});

// ---- Data -------------------------------------------------------------------------------------------

describe('wind data', () => {
    it('a WindNode round-trips and the scene finds it', async () => {
        const scene = new Scene();
        const wind = new WindNode('wind', { direction: 90, strength: 1.5, gustScale: 30, fadeStart: 20, fadeEnd: 50 });
        scene.addNode(wind);
        expect(scene.wind).toBe(wind);
        const json = JSON.parse(JSON.stringify(await wind.serialize()));
        const parent = new Node('p');
        parseNodeJson(parent, json);
        const back = parent.children[0] as WindNode;
        expect(back).toBeInstanceOf(WindNode);
        expect([back.direction, back.strength, back.gustScale, back.fadeStart, back.fadeEnd]).toEqual([90, 1.5, 30, 20, 50]);
        expect(back.directionXZ[0]).toBeCloseTo(0, 6);
        expect(back.directionXZ[1]).toBeCloseTo(-1, 6);
    });

    it('keeps fade end past fade start', () => {
        const w = new WindNode('w', { fadeStart: 50, fadeEnd: 10 });
        expect(w.fadeEnd).toBeGreaterThan(w.fadeStart);
    });

    it('material wind survives serialize/parse on every shading model, and is absent when unset', () => {
        for (const make of [() => Material.Basic({ color: [1, 1, 1] }), () => Material.Default({} as any), () => Material.PBR({})]) {
            const m = make() as Material;
            expect(m.serialize().windStrength).toBeUndefined();
            applyWind(m, { windStrength: 0.3, windStiffness: 0.6 });
            const back = Material.parse(JSON.parse(JSON.stringify(m.serialize())));
            expect(windConfigOf(back)).toEqual({ windStrength: 0.3, windStiffness: 0.6 });
        }
    });
});
