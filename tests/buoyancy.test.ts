import { describe, it, expect } from 'vitest';
import { World, Body, Box, Sphere, Cylinder, Vec3, Quaternion, Plane } from 'cannon-es';
import { applyBuoyancy, floats, shapeSamples, type BuoyancyVolume } from '../src/physics/buoyancy';
import { shapeMassProperties } from '../src/physics/massProperties';

// Buoyancy is Archimedes, sampled: whether a body floats and how low it rides must fall out of its MASS
// against the water its volume displaces, and pushing at each submerged sample point must right a body
// the way a real one rights itself. These run the real solver against a bare cannon world.

const G = 9.81;
const WATER: BuoyancyVolume = { min: [-20, -4, -20], max: [20, 0, 20], density: 1000, linearDrag: 2.5, angularDrag: 1.5 };

function world(volume: BuoyancyVolume = WATER, floor = true): World {
    const w = new World();
    w.gravity.set(0, -G, 0);
    w.addEventListener('preStep', () => {
        for (const b of w.bodies) if (floats(b, volume, () => false)) applyBuoyancy(b, volume, G, w.dt);
    });
    if (floor) {
        const ground = new Body({ mass: 0, shape: new Plane() });
        ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
        ground.position.set(0, volume.min[1], 0);
        w.addBody(ground);
    }
    return w;
}

function run(w: World, seconds: number) {
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
            const s = shapeSamples(shape)!;
            expect(s.points.length).toBeGreaterThan(3);
            expect(s.weight * s.points.length).toBeCloseTo(shapeMassProperties(shape).volume, 6);
        }
    });

    it('floats a body at the depth its mass displaces (500 kg/m³ rides half under)', () => {
        const w = world();
        const b = box(0.5, 0.5, 0.5, 500);   // 1 m³ at 500 kg/m³
        w.addBody(b);
        run(w, 12);
        // Half submerged: the centre sits on the surface. Sampling quantizes depth, so within ~a cell.
        expect(Math.abs(b.position.y)).toBeLessThan(0.15);
        expect(b.velocity.length()).toBeLessThan(0.05);
    });

    it('rides a light body higher than a heavy one of the same size', () => {
        const w = world();
        const light = box(0.5, 0.5, 0.5, 250); light.position.x = -5;
        const heavy = box(0.5, 0.5, 0.5, 750); heavy.position.x = 5;
        w.addBody(light); w.addBody(heavy);
        run(w, 12);
        expect(light.position.y).toBeGreaterThan(heavy.position.y + 0.3);
        expect(light.position.y).toBeGreaterThan(0);     // most of it above the water
        expect(heavy.position.y).toBeLessThan(0);        // most of it below
    });

    it('sinks a body denser than water to the floor', () => {
        const w = world();
        const b = box(0.3, 0.3, 0.3, 0.216 * 2000);   // 2000 kg/m³
        w.addBody(b);
        run(w, 10);
        expect(b.position.y).toBeLessThan(WATER.min[1] + 0.5);
    });

    it('settles a dropped body rather than bouncing for ever (drag)', () => {
        const w = world();
        const b = box(0.5, 0.5, 0.5, 400, 3);
        w.addBody(b);
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
        w.addBody(log);
        run(w, 20);
        const up = log.quaternion.vmult(new Vec3(0, 1, 0));
        expect(Math.abs(up.y)).toBeLessThan(0.3);   // its long axis is near horizontal
    });

    it('leaves character bodies alone unless the volume asks', () => {
        const w = new World();
        w.gravity.set(0, -G, 0);
        const character = box(0.3, 0.9, 0.3, 70, -1);
        w.addEventListener('preStep', () => {
            for (const b of w.bodies) if (floats(b, WATER, x => x === character)) applyBuoyancy(b, WATER, G, w.dt);
        });
        w.addBody(character);
        run(w, 0.5);
        expect(character.velocity.y).toBeLessThan(-3);   // falling freely, never pushed up
    });

    it('does nothing outside the water box', () => {
        const w = world();
        const b = box(0.5, 0.5, 0.5, 300);
        b.position.set(30, -1, 0);
        w.addBody(b);
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
        calm.addBody(a); waved.addBody(b);
        calm.step(1 / 60); waved.step(1 / 60);
        expect(b.velocity.y).toBeGreaterThan(a.velocity.y);   // more of it under a raised surface
    });
});

// Quaternion import kept for readers extending these; cannon's setFromEuler covers the cases above.
void Quaternion;
