import { describe, it, expect } from 'vitest';
import { Body, Box, Sphere, Heightfield, Vec3 } from 'cannon-es';
import { CannonWorld } from '../src/physics/pal/cannon/cannonWorld';
import { CannonBody } from '../src/physics/pal/cannon/cannonBody';
import type { BodyHandle } from '../src/physics/pal/types';

/**
 * CannonWorld.raycast gathers its own candidates instead of asking cannon's broad phase, and drops what the
 * ray cannot report before measuring anything: no-response bodies, sensors and the caster's own body when
 * asked, dynamic bodies for a ground probe. What has to hold is that the NEAREST hit a caller keeps — after
 * its own filters, which stay — is exactly the one cannon's `raycastAll` led to.
 */

// Deterministic, so a failure reproduces.
function rng(seed: number) {
    return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

interface Scene { world: CannonWorld; ignored: Body }

function scene(seed: number): Scene {
    const r = rng(seed);
    const world = new CannonWorld([0, -9.82, 0]);
    const add = (b: Body) => { world.raw.addBody(b); return b; };
    // A body measures its box when it is constructed, at the origin: moved afterwards it must be flagged,
    // or every ray would see it where it was born.
    const at = (b: Body) => { b.position.set(r() * 40 - 20, r() * 6, r() * 40 - 20); b.aabbNeedsUpdate = true; return b; };
    // Ground: a heightfield, whose box is infinite, so every ray tests it.
    const rows = 8, data: number[][] = [];
    for (let i = 0; i < rows; i++) { data.push([]); for (let j = 0; j < rows; j++) data[i].push(r() * 1.5); }
    const ground = new Body({ mass: 0, shape: new Heightfield(data, { elementSize: 8 }) });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    ground.position.set(-28, -1, 28);
    ground.aabbNeedsUpdate = true;
    add(ground);
    for (let i = 0; i < 25; i++) add(at(new Body({ mass: 0, shape: new Box(new Vec3(0.5 + r() * 2, 0.5 + r() * 2, 0.5 + r() * 2)) })));
    for (let i = 0; i < 12; i++) add(at(new Body({ mass: 1, shape: new Sphere(0.3 + r()) })));
    for (let i = 0; i < 10; i++) add(at(new Body({ mass: 0, isTrigger: true, shape: new Box(new Vec3(1 + r(), 1 + r(), 1 + r())) })));
    for (let i = 0; i < 5; i++) { const b = at(new Body({ mass: 0, shape: new Sphere(1 + r()) })); b.collisionResponse = false; add(b); }
    const ignored = add(at(new Body({ mass: 1, shape: new Sphere(1.2) })));
    return { world, ignored };
}

interface Filter { checkCollisionResponse: boolean; groundOnly: boolean; includeTriggers: boolean; ignore: Body | null }

/** The nearest hit after the caller-side filters PhysicsSystem.raycast applies, from a stream of hits. */
function nearestOf(collect: (onHit: (body: Body, distance: number) => void) => void, f: Filter) {
    let best: { id: number; distance: number } | null = null;
    collect((body, distance) => {
        if (best && distance >= best.distance) return;
        if (f.ignore && body === f.ignore) return;
        if (!f.includeTriggers && body.isTrigger) return;
        if (f.groundOnly && body.type === Body.DYNAMIC) return;
        best = { id: body.id, distance };
    });
    return best;
}

describe('CannonWorld.raycast candidate filter', () => {
    it('keeps the nearest hit cannon raycastAll leads to, under every filter combination', () => {
        let compared = 0, hits = 0;
        const bodiesHit = new Set<string>();
        for (let seed = 1; seed <= 6; seed++) {
            const { world, ignored } = scene(seed);
            const byId = new Map(world.raw.bodies.map(b => [b.id, b]));
            const r = rng(seed * 977);
            for (let k = 0; k < 120; k++) {
                const from = [r() * 50 - 25, r() * 10 + 0.5, r() * 50 - 25];
                const to = [r() * 50 - 25, r() * 6 - 2, r() * 50 - 25];
                for (const f of [
                    { checkCollisionResponse: true, groundOnly: false, includeTriggers: false, ignore: ignored },
                    { checkCollisionResponse: true, groundOnly: true, includeTriggers: false, ignore: null },
                    { checkCollisionResponse: false, groundOnly: false, includeTriggers: true, ignore: null },
                    { checkCollisionResponse: true, groundOnly: false, includeTriggers: true, ignore: ignored },
                ] as Filter[]) {
                    const reference = nearestOf(onHit => {
                        world.raw.raycastAll(new Vec3(from[0], from[1], from[2]), new Vec3(to[0], to[1], to[2]),
                            { checkCollisionResponse: f.checkCollisionResponse },
                            res => { if (res.hasHit && res.body) onHit(res.body, res.distance); });
                    }, f);
                    const filtered = nearestOf(onHit => {
                        world.raycast(from, to, {
                            mode: 'all',
                            includeNoResponse: !f.checkCollisionResponse,
                            excludeDynamic: f.groundOnly,
                            excludeSensors: !f.includeTriggers,
                            ignore: f.ignore ? f.ignore.id as BodyHandle : undefined,
                        }, hit => onHit(byId.get(hit.body)!, hit.distance));
                    }, f);
                    expect(filtered?.id ?? null).toBe(reference?.id ?? null);
                    if (reference) { expect(filtered!.distance).toBe(reference.distance); hits++; bodiesHit.add(`${seed}:${reference.id}`); }
                    compared++;
                }
            }
        }
        expect(compared).toBe(6 * 120 * 4);
        expect(hits).toBeGreaterThan(400);   // the sample actually hits things
        expect(bodiesHit.size).toBeGreaterThan(40);   // many different bodies, not just the ground
    });

    it('accepts a list of bodies to ignore', () => {
        const { world, ignored } = scene(42);
        const ids: BodyHandle[] = [ignored.id as BodyHandle, -1 as BodyHandle];
        const from = [ignored.position.x, ignored.position.y + 10, ignored.position.z];
        const to = [ignored.position.x, ignored.position.y - 10, ignored.position.z];
        const seen: number[] = [];
        world.raycast(from, to, { mode: 'all', ignore: ids }, hit => seen.push(hit.body));
        expect(seen).not.toContain(ignored.id);
        world.raycast(from, to, { mode: 'all' }, hit => seen.push(hit.body));
        expect(seen).toContain(ignored.id);
    });

    it('answers closest mode with the nearest reportable hit', () => {
        const { world } = scene(7);
        const r = rng(99);
        for (let k = 0; k < 60; k++) {
            const from = [r() * 50 - 25, r() * 10 + 0.5, r() * 50 - 25];
            const to = [r() * 50 - 25, -3, r() * 50 - 25];
            let all: number | null = null;
            world.raycast(from, to, { mode: 'all' }, hit => { if (all === null || hit.distance < all) all = hit.distance; });
            let closest: number | null = null;
            world.raycast(from, to, { mode: 'closest' }, hit => { closest = hit.distance; });
            expect(closest).toBe(all);
        }
    });
});

describe('CannonBody box refresh', () => {
    it('flags its box for re-measuring only when a set actually moves or turns it', () => {
        const b = new CannonBody({ mass: 0, shape: new Box(new Vec3(1, 2, 3)) });
        b.setPosition([4, 5, 6]);
        b.setQuaternion([0, 0.3826834, 0, 0.9238795]);
        b.updateAABB();
        expect(b.aabbNeedsUpdate).toBe(false);
        b.setPosition([4, 5, 6]);
        expect(b.aabbNeedsUpdate).toBe(false);
        b.setQuaternion([0, 0.3826834, 0, 0.9238795]);
        expect(b.aabbNeedsUpdate).toBe(false);
        b.setPosition([4, 5, 6.5]);
        expect(b.aabbNeedsUpdate).toBe(true);
        b.updateAABB();
        b.setQuaternion([0, 0, 0, 1]);
        expect(b.aabbNeedsUpdate).toBe(true);
    });

    it('keeps a box an unchanged set left alone equal to a fresh measurement', () => {
        const b = new CannonBody({ mass: 0, shape: new Box(new Vec3(1, 1, 1)) });
        b.setPosition([1, 2, 3]);
        b.updateAABB();
        const lo = b.aabb.lowerBound.clone(), hi = b.aabb.upperBound.clone();
        b.setPosition([1, 2, 3]);
        b.updateAABB();
        expect(b.aabb.lowerBound.almostEquals(lo, 0)).toBe(true);
        expect(b.aabb.upperBound.almostEquals(hi, 0)).toBe(true);
    });
});
