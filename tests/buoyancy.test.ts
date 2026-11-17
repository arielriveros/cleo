import { describe, it, expect } from 'vitest';
import { Body, Box, Sphere, Cylinder, Vec3, Quaternion, Plane } from 'cannon-es';
import { applyBuoyancy, floats, shapeSamples, type BuoyancyVolume } from '../src/physics/buoyancy';
import { shapeMassProperties } from '../src/physics/pal/cannon/massProperties';
import { CannonWorld } from '../src/physics/pal/cannon/cannonWorld';
import { cannonColliderParts } from '../src/physics/pal/cannon/parts';
import type { BodyHandle } from '../src/physics/pal/types';

// Buoyancy is Archimedes, sampled: whether a body floats and how low it rides must fall out of its MASS
// against the water its volume displaces, and pushing at each submerged sample point must right a body
// the way a real one rights itself. These run the real solver, through the physics layer's cannon world.

const G = 9.81;
const WATER: BuoyancyVolume = { min: [-20, -4, -20], max: [20, 0, 20], density: 1000, linearDrag: 2.5, angularDrag: 1.5 };

/** A cannon world that buoys every dynamic body in `volume` each substep. */
function world(volume: BuoyancyVolume = WATER, floor = true, isCharacter: (b: Body) => boolean = () => false): CannonWorld {
    const w = new CannonWorld([0, -G, 0]);
    w.onPreSubstep = dt => {
        for (const b of w.raw.bodies)
            if (b.type === Body.DYNAMIC && floats(b, volume, isCharacter)) applyBuoyancy(w, b.id as BodyHandle, b.mass, volume, G, dt);
    };
    if (floor) {
        const ground = new Body({ mass: 0, shape: new Plane() });
        ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
        ground.position.set(0, volume.min[1], 0);
        w.raw.addBody(ground);
    }
    return w;
}

function run(w: CannonWorld, seconds: number) {
    const h = 1 / 60;
    for (let t = 0; t < seconds; t += h) w.step(h);
}

const box = (hx: number, hy: number, hz: number, mass: number, y = 0.5) => {
    const b = new Body({ mass, shape: new Box(new Vec3(hx, hy, hz)) });
    b.position.set(0, y, 0);
    return b;
};

describe('buoyancy', () => {
    it('samples every shape kind with weights summing to its volume', () => {
        for (const shape of [new Box(new Vec3(0.4, 0.2, 1.2)), new Sphere(0.5), new Cylinder(0.3, 0.3, 2, 12)]) {
            const holder = new Body({ mass: 1 });
            holder.addShape(shape);
            const s = shapeSamples(cannonColliderParts(holder)[0].shape)!;
            expect(s.points.length).toBeGreaterThan(3);
            expect(s.weight * s.points.length).toBeCloseTo(shapeMassProperties(shape).volume, 6);
        }
    });

    it('floats a body at the depth its mass displaces (500 kg/m³ rides half under)', () => {
        const w = world();
        const b = box(0.5, 0.5, 0.5, 500);   // 1 m³ at 500 kg/m³
        w.raw.addBody(b);
        run(w, 12);
        // Half submerged: the centre sits on the surface. Sampling quantizes depth, so within ~a cell.
        expect(Math.abs(b.position.y)).toBeLessThan(0.15);
        expect(b.velocity.length()).toBeLessThan(0.05);
    });

    it('rides a light body higher than a heavy one of the same size', () => {
        const w = world();
        const light = box(0.5, 0.5, 0.5, 250); light.position.x = -5;
        const heavy = box(0.5, 0.5, 0.5, 750); heavy.position.x = 5;
        w.raw.addBody(light); w.raw.addBody(heavy);
        run(w, 12);
        expect(light.position.y).toBeGreaterThan(heavy.position.y + 0.3);
        expect(light.position.y).toBeGreaterThan(0);     // most of it above the water
        expect(heavy.position.y).toBeLessThan(0);        // most of it below
    });

    it('sinks a body denser than water to the floor', () => {
        const w = world();
        const b = box(0.3, 0.3, 0.3, 0.216 * 2000);   // 2000 kg/m³
        w.raw.addBody(b);
        run(w, 10);
        expect(b.position.y).toBeLessThan(WATER.min[1] + 0.5);
    });

    it('settles a dropped body rather than bouncing for ever (drag)', () => {
        const w = world();
        const b = box(0.5, 0.5, 0.5, 400, 3);
        w.raw.addBody(b);
        // A floating body is a lightly damped spring (stiffness ρ·g·waterline area): it rings for a few
        // seconds, as a real one does, then comes to rest.
        run(w, 15);
        expect(b.velocity.length()).toBeLessThan(0.05);
        expect(b.angularVelocity.length()).toBeLessThan(0.05);
    });

    it('rights a tipped log onto its side (torque from where the water pushes)', () => {
        const w = world();
        // A long box standing upright: unstable when floating, so it must fall over to lie flat.
        const log = box(0.2, 1.2, 0.2, 0.384 * 550);
        log.quaternion.setFromEuler(0.15, 0, 0.1);
        w.raw.addBody(log);
        run(w, 20);
        const up = log.quaternion.vmult(new Vec3(0, 1, 0));
        expect(Math.abs(up.y)).toBeLessThan(0.3);   // its long axis is near horizontal
    });

    it('leaves character bodies alone unless the volume asks', () => {
        const character = box(0.3, 0.9, 0.3, 70, -1);
        const w = world(WATER, false, x => x === character);
        w.raw.addBody(character);
        run(w, 0.5);
        expect(character.velocity.y).toBeLessThan(-3);   // falling freely, never pushed up
    });

    it('does nothing outside the water box', () => {
        const w = world();
        const b = box(0.5, 0.5, 0.5, 300);
        b.position.set(30, -1, 0);
        w.raw.addBody(b);
        w.step(1 / 60);
        expect(b.velocity.y).toBeLessThan(0);   // only gravity acted
    });

    it('ignores static bodies and triggers', () => {
        const s = new Body({ mass: 0, shape: new Sphere(1) });
        const t = new Body({ mass: 1, shape: new Sphere(1), isTrigger: true });
        expect(floats(s, WATER, () => false)).toBe(false);
        expect(floats(t, WATER, () => false)).toBe(false);
    });

    it('follows a waving surface', () => {
        const calm = world({ ...WATER }, false);
        const waved = world({ ...WATER, surfaceAt: () => 0.3 }, false);
        const a = box(0.5, 0.5, 0.5, 500, 0), b = box(0.5, 0.5, 0.5, 500, 0);
        calm.raw.addBody(a); waved.raw.addBody(b);
        calm.step(1 / 60); waved.step(1 / 60);
        expect(b.velocity.y).toBeGreaterThan(a.velocity.y);   // more of it under a raised surface
    });
});

// Quaternion import kept for readers extending these; cannon's setFromEuler covers the cases above.
void Quaternion;

// The water's motion: pressure along the water's slope (Froude–Krylov), drag toward the waves' orbits and
// the current, for the water displaced rather than the body's mass, one water per point where two overlap,
// and the same clock as the surface that is drawn.
describe('water motion', () => {
    it('pushes a floating body down a sloped surface, with no current at all', () => {
        // A surface falling 1 m per 20 m along +x, still water (no flow).
        const sloped: BuoyancyVolume = {
            ...WATER, columnAt: (x) => ({ surface: -0.05 * x, rest: -0.05 * x, floor: -4, flowX: 0, flowZ: 0 }),
        };
        const w = world(sloped, false);
        const b = box(0.5, 0.5, 0.5, 500, 0);
        w.raw.addBody(b);
        run(w, 2);
        expect(b.position.x).toBeGreaterThan(0.2);   // downhill
    });

    it('lets a floater ride the waves: carried forward on a crest, back in a trough', () => {
        // The water's surface velocity alternates along +x with a 4 s period; the surface itself stays flat.
        let t = 0;
        const orbit: BuoyancyVolume = {
            ...WATER, linearDrag: 4,
            columnAt: () => ({ surface: 0, rest: 0, floor: -4, flowX: 0, flowZ: 0, waveVX: Math.cos(t * Math.PI / 2), waveVY: 0, waveVZ: 0, waveK: 0.1 }),
        };
        const w = world(orbit, false);
        const b = box(0.4, 0.4, 0.4, 0.512 * 400, 0);
        w.raw.addBody(b);
        const h = 1 / 60;
        let agree = 0, samples = 0;
        for (; t < 12; t += h) {
            w.step(h);
            if (t > 4) { samples++; if (Math.sign(b.velocity.x) === Math.sign(Math.cos((t - 0.3) * Math.PI / 2))) agree++; }
        }
        expect(agree / samples).toBeGreaterThan(0.8);
    });

    it('drags by the water displaced, not by mass: the denser body sinks faster', () => {
        const w = world(WATER, false);
        const light = box(0.3, 0.3, 0.3, 0.216 * 2000, -1); light.position.x = -5;
        const heavy = box(0.3, 0.3, 0.3, 0.216 * 4000, -1); heavy.position.x = 5;
        w.raw.addBody(light); w.raw.addBody(heavy);
        run(w, 0.8);
        expect(heavy.velocity.y).toBeLessThan(light.velocity.y * 1.5);   // both negative: heavy much faster
    });

    it('buoys a body in two overlapping waters once, in the one the other gives way to', () => {
        const lake: BuoyancyVolume = { ...WATER, id: 'lake' };
        const mouth: BuoyancyVolume = { ...WATER, id: 'river', yieldsTo: ['lake'], density: 3000 };
        const single = new CannonWorld([0, -G, 0]), both = new CannonWorld([0, -G, 0]);
        const a = box(0.5, 0.5, 0.5, 500, 0), b = box(0.5, 0.5, 0.5, 500, 0);
        let fromRiver = 0;
        single.onPreSubstep = dt => { applyBuoyancy(single, a.id as BodyHandle, a.mass, lake, G, dt); };
        both.onPreSubstep = dt => {
            applyBuoyancy(both, b.id as BodyHandle, b.mass, [mouth, lake], G, dt, (i, f) => { if (i === 0) fromRiver += f; });
        };
        single.raw.addBody(a); both.raw.addBody(b);
        run(single, 6); run(both, 6);
        expect(b.position.y).toBeCloseTo(a.position.y, 2);   // the lake's water, once: not the denser river's, not both
        expect(fromRiver).toBe(0);
    });

    it('fades the waves out on an ocean beach for physics as the surface does, the surf running in instead', async () => {
        const { waterSpecColumn } = await import('../src/physics/waterSurface');
        const { wavesForWind } = await import('../src/physics/water/waves');
        const { surfOf } = await import('../src/physics/water/surf');
        const ocean = { id: 'o', type: 'ocean' as const, priority: 0, order: 0, min: [-1e7, -50, -1e7] as [number, number, number],
            max: [1e7, 0, 1e7] as [number, number, number], level: 0, floor: -50, outline: [], samples: [], cell: 1, grid: {}, endless: true, waveFactor: 1 };
        // A shore grid: land at x >= 100, the bed rising toward it.
        const nx = 64, nz = 4, cell = 4;
        const data = new Float32Array(nx * nz * 2);
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const wx = x * cell;
            data[(z * nx + x) * 2] = 100 - wx;            // metres to the shore
            data[(z * nx + x) * 2 + 1] = -0.2 * (100 - wx); // the bed
        }
        const spec = {
            min: [-1e7, -50, -1e7] as [number, number, number], max: [1e7, 0, 1e7] as [number, number, number],
            density: 1025, linearDrag: 2, angularDrag: 0.5, affectCharacters: false, waveAmplitude: 0, waveFrequency: 0,
            shapes: [ocean], waves: wavesForWind(8, 90, Infinity), waveScale: 1, shoreFade: 10,
            shoreGrid: { originX: 0, originZ: 0, cell, nx, nz, data },
        };
        const swing = (x: number) => {
            let lo = Infinity, hi = -Infinity;
            for (let t = 0; t < 12; t += 0.25) { const s = waterSpecColumn(spec, x, 4, t)!.surface; lo = Math.min(lo, s); hi = Math.max(hi, s); }
            return hi - lo;
        };
        expect(swing(20)).toBeGreaterThan(0.2);
        // At the waterline the sea's waves are gone; what moves the water is the surf, no taller than its
        // run-up: 0.78 of the depth (0.4 m here) plus half the sea's amplitude, trough to crest.
        const a = surfOf(spec.waves, 1).amplitude;
        expect(swing(98)).toBeGreaterThan(0.02);
        expect(swing(98)).toBeLessThanOrEqual(2 * (0.39 * 0.4 + 0.5 * a) + 1e-6);
        // And floaters there are carried in with each breaker and out with the backwash.
        let inward = 0, outward = 0;
        for (let t = 0; t < 12; t += 0.25) {
            const v = waterSpecColumn(spec, 90, 4, t)!.waveVX ?? 0;
            inward = Math.max(inward, v); outward = Math.min(outward, v);
        }
        expect(inward).toBeGreaterThan(0.05);
        expect(outward).toBeLessThan(-0.05);
    });

    it('runs the waves on the physics\u2019 drawn time while it steps, else on the render clock', async () => {
        const { setWaterClock, waterTime } = await import('../src/physics/water/waterClock');
        setWaterClock(42);
        expect(waterTime(1000)).toBe(42);
    });
});
