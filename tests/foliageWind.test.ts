import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { rendererSource } from './helpers/rendererSource';
// @ts-expect-error -- plain .mjs shared with the bundler configs; it has no declarations.
import { translateWgsl } from '../tools/wgslTranslate.mjs';
// @ts-expect-error -- same.
import { resolveIncludes, listVariants } from '../tools/shaderIncludes.mjs';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { WindNode } from '../src/core/scene/nodes/windNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { Material, applyWind, windConfigOf } from '../src/graphics/material';
import { ForceFieldNode } from '../src/core/scene/nodes/forceFieldNode';
import { sampleWindField, windGustAt, WIND_REFERENCE_SPEED, MAX_WIND_SOURCES } from '../src/core/wind/windField';

// Foliage wind: the scene's wind FIELD (WindNode + the Force Fields that move the air), per-material
// response, and a vertex displacement compiled into `wind` variants of the instanced foliage programs only.
// These pin the parts that matter: plants stay rooted, parts of one plant bend identically, the lean
// follows the local air, non-wind programs are untouched, and the shadow sways with its plant.

const WGSL = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const read = (p: string) => readFileSync(join(WGSL, p), 'utf-8');

// ---- A CPU mirror of chunks/foliageWind.wgsl ------------------------------------------------------
// The air comes from the wind field's own CPU twin (core/wind/windField.ts, pinned against the WGSL in
// windField.test.ts); what is mirrored here is what the foliage does with it.

const fract = (x: number) => x - Math.floor(x);
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

type W = { dir: [number, number]; strength: number; wavelength: number; speed: number; gustiness: number; veer: number;
           fadeStart: number; fadeEnd: number; lean: number; stiffness: number; minY: number; height: number;
           cam: [number, number, number]; sources?: Float32Array; count?: number };
const W0: W = { dir: [1, 0], strength: 1, wavelength: 18, speed: 4, gustiness: 0.8, veer: 20 * Math.PI / 180,
                fadeStart: 40, fadeEnd: 70, lean: 0.3, stiffness: 1, minY: 0, height: 1, cam: [0, 2, 0] };

type Plant = { lean: [number, number]; dir: [number, number]; gust: number; strength: number; fade: number };
const params = (w: W, t: number) => [w.dir[0], w.dir[1], w.strength, w.wavelength, t, w.speed, w.gustiness, w.veer];
const fadeOf = (origin: number[], w: W) =>
    1 - smoothstep(w.fadeStart, w.fadeEnd, Math.hypot(origin[0] - w.cam[0], origin[1] - w.cam[1], origin[2] - w.cam[2]));

/** windPlantAt. */
function plantAt(origin: number[], t: number, w: W): Plant {
    const fade = fadeOf(origin, w);
    if (fade <= 0) return { lean: [0, 0], dir: w.dir, gust: 0, strength: 0, fade: 0 };
    const s = sampleWindField(params(w, t), w.sources ?? new Float32Array(0), w.count ?? 0, origin[0], origin[1], origin[2]);
    const nx = s.velocity[0] / WIND_REFERENCE_SPEED, nz = s.velocity[2] / WIND_REFERENCE_SPEED;
    const m = Math.hypot(nx, nz);
    const dir: [number, number] = m > 1e-4 ? [nx / m, nz / m] : w.dir;
    const stiffness = Math.max(w.stiffness, 0.05);
    const sway = Math.sin(t * (1.7 / stiffness) + hash(Math.floor(origin[0] * 4), Math.floor(origin[2] * 4)) * 6.2831853);
    const strength = s.steady / WIND_REFERENCE_SPEED;
    const k = w.lean / stiffness * fade;
    return { lean: [(nx + dir[0] * 0.2 * strength * sway) * k, (nz + dir[1] * 0.2 * strength * sway) * k], dir, gust: s.gust, strength, fade };
}

/** Instance = translation + uniform scale, which is what foliage bakes. */
function displace(objPos: number[], origin: number[], scale: number, t: number, w: W): number[] {
    const world = objPos.map((v, i) => origin[i] + v * scale);
    const base = [origin[0], origin[1] + w.minY * scale, origin[2]];
    const h = Math.min(1, Math.max(0, (objPos[1] - w.minY) / w.height));
    const plant = plantAt(origin, t, w);
    const bend = h * h * w.height * scale;
    const rel = world.map((v, i) => v - base[i]);
    const len = Math.hypot(...rel);
    const bent = [rel[0] + plant.lean[0] * bend, rel[1], rel[2] + plant.lean[1] * bend];
    const bl = Math.hypot(...bent);
    return bl > 1e-5 ? bent.map((v, i) => base[i] + v * len / bl) : world;
}

// ---- The LEAVES layers (phase 2) -------------------------------------------------------------------

const wave = (x: number) => { const f = Math.abs((x + 0.5 - Math.floor(x + 0.5)) * 2 - 1); return f * f * (3 - 2 * f) * 2 - 1; };
/** windLeafOffset, normal pointing +X; instance = translation + uniform scale. */
function leafOffset(obj: number[], origin: number[], scale: number, t: number, w: W, radius: number, flutter: number): number[] {
    const h = Math.min(1, Math.max(0, (obj[1] - w.minY) / w.height));
    const heightW = w.height * scale;
    const b = radius > 1e-4 ? smoothstep(0.15 * radius, radius, Math.hypot(obj[0], obj[2])) * h : h;
    const plant = plantAt(origin, t, w);
    const f = flutter * b * plant.fade * plant.strength;
    const gust = plant.gust;
    const cells = radius > 1e-4 ? 4 / radius : 8;
    const c = obj.map(v => Math.floor(v * cells));
    const phase = hash(c[0] + c[1] * 7.13 + origin[0], c[2] + c[1] * 1.71 + origin[2]);
    const swing = wave(t * (1.6 / w.stiffness) + phase), lift = wave(t * (1.1 / w.stiffness) + phase * 1.7 + 0.25);
    const sprig = f * 0.05 * heightW * (0.4 + 0.6 * gust);
    const sp = hash(obj[0] * 37 + obj[1] * 11, obj[2] * 37) * 6.2831853;
    const shimmer = Math.sin(t * 44 + sp) * f * 0.004 * heightW * (0.5 + 0.5 * gust);
    return [plant.dir[0] * swing * sprig + shimmer, 0.35 * lift * sprig, plant.dir[1] * swing * sprig];
}

/** Force fields' packed records, for a wind made of local sources. */
function sources(...fields: ForceFieldNode[]): { sources: Float32Array; count: number } {
    const out = new Float32Array(MAX_WIND_SOURCES * 16);
    fields.forEach((f, i) => f.packInto(out, i * 16));
    return { sources: out, count: fields.length };
}

describe('leaves move on their own, without leaving the tree', () => {
    const tree = { ...W0, lean: 0.08, stiffness: 1.5, minY: 0, height: 20 };
    const R = 5;

    it('the motion vanishes at the trunk axis and at the root, so needles stay on their branches', () => {
        for (const t of [0.3, 1.7, 4.2]) {
            expect(Math.hypot(...leafOffset([0.2, 12, 0.1], [0, 0, -10], 1, t, tree, R, 1))).toBeLessThan(1e-9);
            expect(Math.hypot(...leafOffset([4.5, 0, 0], [0, 0, -10], 1, t, tree, R, 1))).toBeLessThan(1e-9);
        }
    });

    it('outer canopy leaves move, but only by a few percent of the tree height', () => {
        let most = 0;
        for (let t = 0; t < 4; t += 0.05) most = Math.max(most, Math.hypot(...leafOffset([4.8, 16, 0], [0, 0, -10], 1, t, tree, R, 1)));
        expect(most).toBeGreaterThan(0.05);           // visibly alive
        expect(most).toBeLessThan(0.06 * 20);         // never more than ~6% of the tree: they stay attached
    });

    it('neighbouring sprigs swing out of step, so the canopy does not move as one sheet', () => {
        const a = leafOffset([4.8, 16, 0], [0, 0, -10], 1, 2.0, tree, R, 1);
        const b = leafOffset([-4.8, 15, 1.3], [0, 0, -10], 1, 2.0, tree, R, 1);
        expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBeGreaterThan(1e-3);
    });

    it('a trunkless grass card flutters from the tip, weighted by height alone', () => {
        const grass = { ...W0, height: 1 };
        expect(Math.hypot(...leafOffset([0, 0, 0], [3, 0, 3], 0.7, 1.1, grass, 0, 0.8))).toBe(0);
        let tip = 0;
        for (let t = 0; t < 3; t += 0.05) tip = Math.max(tip, Math.hypot(...leafOffset([0.1, 1, 0], [3, 0, 3], 0.7, t, grass, 0, 0.8)));
        expect(tip).toBeGreaterThan(0.005);
    });
});

describe('leaf wiring', () => {
    const chunk = readFileSync(join(WGSL, 'chunks/foliageWind.wgsl'), 'utf-8');
    const renderer = rendererSource();

    it('only the leaves role runs the leaf layers; bark rides the shared bend unchanged', () => {
        expect(chunk).toContain('if (w.response.w < 0.5) { return trunk; }');
        expect(chunk).toContain('return trunk + windLeafOffset(');
    });

    it('the role and flutter are set per MODEL, the bend per LAYER', () => {
        expect(renderer).toContain("this._setWindUniforms(scene, wind!, model.material)");
        expect(renderer).toContain("const leaves = material.properties.get('windRole') === 'leaves';");
    });

    it('the shadow pass displaces with the same normal-aware function', () => {
        expect(readFileSync(join(WGSL, 'chunks/instancedDepthVertex.wgsl'), 'utf-8')).toMatch(/windDisplace\(world, position, nw/);
    });
});

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

    it('with the base wind alone and no veer, leans exactly as the old global wind did', () => {
        const w = { ...W0, veer: 0 };
        for (const [x, z, t] of [[5, 3, 0.7], [-12, 4, 3.1], [30, -8, 9.4]]) {
            const origin = [x, 0, z];
            const plant = plantAt(origin, t, w);
            const g = windGustAt(x, z, params(w, t));
            const sway = Math.sin(t * 1.7 + hash(Math.floor(x * 4), Math.floor(z * 4)) * 6.2831853);
            const legacy = w.strength * w.lean * (0.2 + 0.8 * g + 0.2 * sway) * fadeOf(origin, w);
            expect(plant.lean[0]).toBeCloseTo(legacy, 9);
            expect(plant.lean[1]).toBeCloseTo(0, 9);
        }
    });

    it('veers: neighbouring meadows lean in different directions, within the veer either way', () => {
        let min = Infinity, max = -Infinity;
        for (let x = -60; x <= 60; x += 6) for (let z = -60; z <= 60; z += 6) {
            const p = plantAt([x, 0, z], 2, { ...W0, cam: [x, 2, z] });
            const a = Math.atan2(p.dir[1], p.dir[0]);
            min = Math.min(min, a); max = Math.max(max, a);
        }
        expect(max - min).toBeGreaterThan(5 * Math.PI / 180);
        expect(Math.max(Math.abs(min), Math.abs(max))).toBeLessThanOrEqual(W0.veer + 1e-6);
    });

    it('a whirlwind alone (no WindNode) leans the plants round it, not toward or away from it', () => {
        const vortex = new ForceFieldNode('whirl', { kind: 'vortex', shape: 'sphere', radius: 10, strength: 7, affectsWind: true });
        const w = { ...W0, strength: 0, ...sources(vortex) };
        for (const origin of [[5, 0, 0], [0, 0, -4], [-3, 0, 3]]) {
            const p = plantAt(origin, 1.3, { ...w, cam: [origin[0], 2, origin[2]] });
            const r = Math.hypot(origin[0], origin[2]);
            const radial = (p.lean[0] * origin[0] + p.lean[1] * origin[2]) / r;
            expect(Math.hypot(...p.lean)).toBeGreaterThan(0.02);
            expect(Math.abs(radial)).toBeLessThan(0.02 * Math.hypot(...p.lean));
        }
    });

    it('a full shelter stills the plants inside it, sway and all', () => {
        const shelter = new ForceFieldNode('lee', { kind: 'drag', shape: 'box', extents: [10, 5, 10], strength: 1, falloff: 0.2, affectsWind: true });
        const w = { ...W0, ...sources(shelter) };
        for (const t of [0.5, 2.2, 6.1]) {
            expect(Math.hypot(...plantAt([2, 0, 1], t, w).lean)).toBeLessThan(1e-12);
            expect(Math.hypot(...plantAt([30, 0, 1], t, { ...w, cam: [30, 2, 1] }).lean)).toBeGreaterThan(1e-3);
        }
    });

    it('a particle-only force field leaves the foliage alone', () => {
        const field = new ForceFieldNode('push', { kind: 'directional', shape: 'global', strength: 20 });
        const still = plantAt([5, 0, 3], 2, W0);
        const pushed = plantAt([5, 0, 3], 2, { ...W0, ...sources(field) });
        expect(pushed.lean).toEqual(still.lean);
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
    // The variant each program sways through: FOLIAGE materials' (wind, interaction, weather) on the mesh
    // programs, the far cards' wind on the billboard. Blinn-Phong has none: foliage is a PBR material.
    const FILES: [string, string][] = [['geometryPBRInstanced.wgsl', 'foliage'], ['geometryFoliageBillboard.wgsl', 'wind'],
                   ['shadowMapInstanced.wgsl', 'foliage'], ['shadowMapInstancedCutout.wgsl', 'foliage'], ['shadowMapInstancedCutout.wgsl', 'wind']];

    it('every instanced foliage program (colour AND shadow) declares its swaying variant', () => {
        for (const [f, tag] of FILES)
            expect((listVariants(read(f)) as { tag: string }[]).map(v => v.tag), f).toContain(tag);
        expect((listVariants(read('geometryBlinnPhongInstanced.wgsl')) as { tag: string }[]).map(v => v.tag)).not.toContain('wind');
    });

    it('only the swaying variant reads the wind time; the base program has it compiled out', async () => {
        for (const [f, tag] of FILES) {
            const variant = (listVariants(read(f)) as { tag: string; defines: object }[]).find(v => v.tag === tag)!;
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
    const renderer = rendererSource();

    it('never sways the impostor bucket, and only buckets that start inside the fade', () => {
        expect(renderer).toContain('const real = !!wind && slot < billboardBucket;');
        expect(renderer).toContain('const windy = real && layer.levels[slot].distance < wind!.fadeEnd;');
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
        const wind = new WindNode('wind', { direction: 90, strength: 1.5, gustScale: 30, gustiness: 0.6, veer: 35, fadeStart: 20, fadeEnd: 50 });
        scene.addNode(wind);
        expect(scene.wind).toBe(wind);
        const json = JSON.parse(JSON.stringify(await wind.serialize()));
        const parent = new Node('p');
        parseNodeJson(parent, json);
        const back = parent.children[0] as WindNode;
        expect(back).toBeInstanceOf(WindNode);
        expect([back.direction, back.strength, back.gustScale, back.gustiness, back.veer, back.fadeStart, back.fadeEnd])
            .toEqual([90, 1.5, 30, 0.6, 35, 20, 50]);
        expect(back.directionXZ[0]).toBeCloseTo(0, 6);
        expect(back.directionXZ[1]).toBeCloseTo(-1, 6);
    });

    it('a wind saved before the field (the Valley\'s) loads with the default gustiness and veer', () => {
        const parent = new Node('p');
        parseNodeJson(parent, { type: 'wind', name: 'Wind', id: 'w1',
            wind: { direction: 25, strength: 1, gustScale: 18, gustSpeed: 4, fadeStart: 35, fadeEnd: 70 } });
        const back = parent.children[0] as WindNode;
        expect([back.direction, back.strength, back.fadeStart, back.gustiness, back.veer]).toEqual([25, 1, 35, 0.8, 20]);
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
            expect(windConfigOf(back)).toEqual({ windStrength: 0.3, windStiffness: 0.6, windRole: 'plant', windFlutter: 0.5 });
            expect(m.serialize().windRole).toBeUndefined();          // defaults are not written
            applyWind(m, { windStrength: 0.1, windRole: 'leaves', windFlutter: 0.7 });
            const leaves = Material.parse(JSON.parse(JSON.stringify(m.serialize())));
            expect(windConfigOf(leaves)).toEqual({ windStrength: 0.1, windStiffness: 1, windRole: 'leaves', windFlutter: 0.7 });
        }
    });
});
