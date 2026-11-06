import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Frustum } from '../src/core/frustum';
import { OcclusionVolumes } from '../src/graphics/occlusion/occlusionVolumes';
import type { VolumeContentKind, VolumeContentSource, VolumeFrameInput, VolumeLike } from '../src/graphics/occlusion/occlusionVolumes';
import type { OcclusionVolumeCull } from '../src/core/scene/nodes/occlusionVolumeNode';

// Occlusion volumes: what lies wholly inside a box is hidden exactly when the camera cannot see the box.
// Driven with fake volumes and content, a real frustum, and stand-ins for the CPU buffer and GPU queries.

type Cull = Partial<OcclusionVolumeCull>;

interface FakeVolume extends VolumeLike {
    worldTransform: mat4;
    size: [number, number, number];
    enabled: boolean;
    transformVersion: number;
    version: number;
    cull: OcclusionVolumeCull;
}

function volume(center: number[], size: [number, number, number], cull: Cull = {}, rotationY = 0): FakeVolume {
    const all: OcclusionVolumeCull = { models: true, sprites: true, particles: true, lights: true, decals: true, fluids: true, shadows: true, ...cull };
    const q = quat.setAxisAngle(quat.create(), [0, 1, 0], rotationY * Math.PI / 180);
    const v: FakeVolume = {
        enabled: true, visible: true, size, transformVersion: 1, version: 1, cull: all,
        worldTransform: mat4.fromRotationTranslation(mat4.create(), q, center as vec3),
        culls: (k: keyof OcclusionVolumeCull) => v.cull[k],
    };
    return v;
}

interface Thing { name: string; min: number[]; max: number[]; v: number }
const thing = (name: string, min: number[], max: number[]): Thing => ({ name, min, max, v: 1 });
const at = (name: string, p: number[]): Thing => thing(name, p, p);

function source(kind: VolumeContentKind, nodes: Thing[], everyFrame = false): VolumeContentSource<Thing> {
    return {
        kind, nodes,
        version: n => everyFrame ? NaN : n.v,
        bounds: (n, min, max) => { vec3.copy(min, n.min as vec3); vec3.copy(max, n.max as vec3); return true; },
    };
}

/** A camera at (0, 1.5, 20) looking down -z, 60 degree fov. */
function view(eye = [0, 1.5, 20], target = [0, 1.5, 0]) {
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 500);
    const vp = mat4.multiply(mat4.create(), proj, mat4.lookAt(mat4.create(), eye as vec3, target as vec3, [0, 1, 0]));
    const f = new Frustum();
    f.setFromViewProjection(vp);
    return { eye, planes: f.planes };
}

/** GPU queries whose verdicts the test sets; records what was offered. */
function queries(hidden = new Set<VolumeLike>()) {
    const offered: VolumeLike[] = [];
    return { hidden, offered, consider: (v: VolumeLike) => { offered.push(v); return true; }, isHidden: (v: VolumeLike) => hidden.has(v) };
}

function frame(volumes: VolumeLike[], sources: VolumeContentSource<any>[], extra: Partial<VolumeFrameInput> = {}): VolumeFrameInput {
    const { eye, planes } = view();
    return { volumes, sources, eye, near: 0.1, planes, cpuOccluded: null, queries: null, ...extra };
}

// In front of the camera, in view: z in [-5, 5].
const ROOM = () => volume([0, 1.5, 0], [10, 3, 10]);
// Behind the camera, out of view.
const BEHIND = () => volume([0, 1.5, 60], [10, 3, 10]);

describe('OcclusionVolumes membership', () => {
    it('hides content wholly inside an unseen box, not content poking out of it', () => {
        const o = new OcclusionVolumes();
        const chair = thing('chair', [-1, 0.1, 58], [1, 1, 60]);
        const pole = thing('pole', [-1, 0.1, 58], [1, 9, 60]);        // taller than the box
        o.update(frame([BEHIND()], [source('models', [chair, pole])]));
        expect(o.hidden.has(chair)).toBe(true);
        expect(o.hidden.has(pole)).toBe(false);
        expect(o.stats).toMatchObject({ tested: 1, hidden: 1, culledNodes: 1 });
    });

    it('tests against the oriented box, not its world bounds', () => {
        const o = new OcclusionVolumes();
        // Turned 45 degrees: its world AABB is ~14 m across, but a corner of that AABB is outside the box.
        const turned = volume([0, 1.5, 60], [10, 3, 10], {}, 45);
        const centre = thing('centre', [-1, 0.5, 59], [1, 1, 61]);
        const corner = thing('corner', [5, 0.5, 64], [6, 1, 65]);
        o.update(frame([turned], [source('models', [centre, corner])]));
        expect(o.hidden.has(centre)).toBe(true);
        expect(o.hidden.has(corner)).toBe(false);
    });

    it('follows the box scale', () => {
        const o = new OcclusionVolumes();
        const v = volume([0, 1.5, 60], [2, 2, 2]);
        mat4.scale(v.worldTransform, v.worldTransform, [5, 1, 5]);    // 10 x 2 x 10 in the world
        const wide = thing('wide', [-4, 1, 56], [4, 2, 64]);
        o.update(frame([v], [source('models', [wide])]));
        expect(o.hidden.has(wide)).toBe(true);
    });

    it('takes a light by its position', () => {
        const o = new OcclusionVolumes();
        const lamp = at('lamp', [0, 2.5, 60]);
        const outside = at('outside', [0, 2.5, 70]);
        o.update(frame([BEHIND()], [source('lights', [lamp, outside])]));
        expect(o.hidden.has(lamp)).toBe(true);
        expect(o.hidden.has(outside)).toBe(false);
    });

    it('re-tests a node only when its version changes, and everything when a volume changes', () => {
        const o = new OcclusionVolumes();
        const v = BEHIND();
        const crate = thing('crate', [-1, 0.5, 59], [1, 1, 61]);
        const src = source('models', [crate]);
        o.update(frame([v], [src]));
        expect(o.hidden.has(crate)).toBe(true);
        // Moved out without saying so: the cached membership stands.
        crate.min[2] += 50; crate.max[2] += 50;
        o.update(frame([v], [src]));
        expect(o.hidden.has(crate)).toBe(true);
        // Now it says so.
        crate.v++;
        o.update(frame([v], [src]));
        expect(o.hidden.has(crate)).toBe(false);
        // Back inside, unannounced again; a change to the volume re-tests everything.
        crate.min[2] -= 50; crate.max[2] -= 50;
        o.update(frame([v], [src]));
        expect(o.hidden.has(crate)).toBe(false);
        v.version++;
        o.update(frame([v], [src]));
        expect(o.hidden.has(crate)).toBe(true);
    });

    it('re-tests a NaN-versioned source every frame', () => {
        const o = new OcclusionVolumes();
        const smoke = thing('smoke', [-1, 0.5, 59], [1, 1, 61]);
        const src = source('particles', [smoke], true);
        const v = BEHIND();
        o.update(frame([v], [src]));
        expect(o.hidden.has(smoke)).toBe(true);
        smoke.max[1] = 20;                                   // its bounds grew out of the box, no version
        o.update(frame([v], [src]));
        expect(o.hidden.has(smoke)).toBe(false);
    });

    it('ignores disabled, hidden and degenerate volumes', () => {
        const o = new OcclusionVolumes();
        const crate = thing('crate', [-1, 0.5, 59], [1, 1, 61]);
        const off = BEHIND(); off.enabled = false;
        const flat = volume([0, 1.5, 60], [10, 0, 10]);
        o.update(frame([off, flat], [source('models', [crate])]));
        expect(o.hidden.size).toBe(0);
        expect(o.stats.tested).toBe(0);
    });
});

describe('OcclusionVolumes visibility', () => {
    it('a box in view is seen; one behind the camera is not', () => {
        const o = new OcclusionVolumes();
        const table = thing('table', [-1, 0, -1], [1, 1, 1]);
        const shelf = thing('shelf', [-1, 0, 59], [1, 1, 61]);
        o.update(frame([ROOM(), BEHIND()], [source('models', [table, shelf])]));
        expect(o.hidden.has(table)).toBe(false);
        expect(o.hidden.has(shelf)).toBe(true);
    });

    it('a box the eye is inside is always seen, and never queried', () => {
        const o = new OcclusionVolumes();
        const q = queries();
        const around = volume([0, 1.5, 20], [6, 3, 6]);
        // Behind the eye, inside the same box: off screen, but that is the per-object cull's business.
        const stool = thing('stool', [-1, 0.5, 21], [1, 1, 22]);
        q.hidden.add(around);
        o.update(frame([around], [source('models', [stool])], { queries: q }));
        expect(o.hidden.has(stool)).toBe(false);
        expect(q.offered).toEqual([]);
    });

    it('a box behind the landscape is not seen', () => {
        const o = new OcclusionVolumes();
        const table = thing('table', [-1, 0, -1], [1, 1, 1]);
        let asked = 0;
        o.update(frame([ROOM()], [source('models', [table])], { cpuOccluded: () => { asked++; return true; } }));
        expect(asked).toBe(1);
        expect(o.hidden.has(table)).toBe(true);
    });

    it('a box a fresh query found hidden is not seen; it is offered every frame either way', () => {
        const o = new OcclusionVolumes();
        const room = ROOM();
        const q = queries();
        const table = thing('table', [-1, 0, -1], [1, 1, 1]);
        const src = source('models', [table]);
        o.update(frame([room], [src], { queries: q }));
        expect(o.hidden.has(table)).toBe(false);
        q.hidden.add(room);
        o.update(frame([room], [src], { queries: q }));
        expect(o.hidden.has(table)).toBe(true);
        expect(o.stats.queryHidden).toBe(1);
        q.hidden.clear();
        o.update(frame([room], [src], { queries: q }));
        expect(o.hidden.has(table)).toBe(false);
        expect(q.offered).toEqual([room, room, room]);
    });

    it('never offers a box with nothing inside', () => {
        const o = new OcclusionVolumes();
        const q = queries();
        o.update(frame([ROOM()], [source('models', [thing('far', [100, 0, 100], [101, 1, 101])])], { queries: q }));
        expect(q.offered).toEqual([]);
        expect(o.stats.tested).toBe(0);
    });

    it('content inside nested volumes is hidden when any of them is', () => {
        const o = new OcclusionVolumes();
        const house = volume([0, 1.5, 0], [20, 3, 20]);
        const room = ROOM();
        const q = queries(new Set([house]));
        const table = thing('table', [-1, 0, -1], [1, 1, 1]);
        o.update(frame([house, room], [source('models', [table])], { queries: q }));
        expect(o.hidden.has(table)).toBe(true);
    });
});

describe('OcclusionVolumes switches', () => {
    const contents = () => ({
        model: thing('model', [-1, 0.5, 59], [1, 1, 61]),
        sprite: thing('sprite', [-1, 0.5, 59], [1, 1, 61]),
        particles: thing('particles', [-1, 0.5, 59], [1, 1, 61]),
        light: at('light', [0, 2, 60]),
        decal: thing('decal', [-1, 0.5, 59], [1, 1, 61]),
        fluid: thing('fluid', [-1, 0.5, 59], [1, 1, 61]),
    });
    const sources = (c: ReturnType<typeof contents>) => [
        source('models', [c.model]), source('sprites', [c.sprite]), source('particles', [c.particles]),
        source('lights', [c.light]), source('decals', [c.decal]), source('fluids', [c.fluid]),
    ];

    it('hides every kind it is switched on for', () => {
        const o = new OcclusionVolumes();
        const c = contents();
        o.update(frame([BEHIND()], sources(c)));
        for (const n of Object.values(c)) expect(o.hidden.has(n)).toBe(true);
        expect(o.shadowHidden.has(c.model)).toBe(true);
    });

    it('leaves a kind switched off alone', () => {
        for (const key of ['models', 'sprites', 'particles', 'lights', 'decals', 'fluids'] as const) {
            const o = new OcclusionVolumes();
            const c = contents();
            o.update(frame([volume([0, 1.5, 60], [10, 3, 10], { [key]: false })], sources(c)));
            const off = { models: c.model, sprites: c.sprite, particles: c.particles, lights: c.light, decals: c.decal, fluids: c.fluid }[key];
            for (const n of Object.values(c)) expect(o.hidden.has(n)).toBe(n !== off);
        }
    });

    it('shadows are a switch of their own', () => {
        const o = new OcclusionVolumes();
        const c = contents();
        o.update(frame([volume([0, 1.5, 60], [10, 3, 10], { shadows: false })], sources(c)));
        expect(o.hidden.has(c.model)).toBe(true);
        expect(o.shadowHidden.has(c.model)).toBe(false);
        o.update(frame([volume([0, 1.5, 60], [10, 3, 10], { models: false })], sources(c)));
        expect(o.hidden.has(c.model)).toBe(false);
        expect(o.shadowHidden.has(c.model)).toBe(true);
        // Shadows are a model's: a light's own shadow goes with the light.
        expect(o.shadowHidden.has(c.light)).toBe(false);
    });

    it('never hides the exempt (selected) node', () => {
        const o = new OcclusionVolumes();
        const c = contents();
        o.update(frame([BEHIND()], sources(c), { exempt: c.model }));
        expect(o.hidden.has(c.model)).toBe(false);
        expect(o.shadowHidden.has(c.model)).toBe(false);
        expect(o.hidden.has(c.light)).toBe(true);
    });
});
