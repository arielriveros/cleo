import { describe, it, expect } from 'vitest';
import { PHYSICS_BACKENDS, resolvePhysicsBackendRequest } from '../src/physics/pal/backendSelect';
import { describePhysicsCapabilities } from '../src/physics/pal/capabilities';
import { acquirePhysicsBackend, acquirePhysicsWorld, isPhysicsBackendLoaded } from '../src/physics/pal/createWorld';
import { PhysicsSystem } from '../src/physics/physicsSystem';

// Which physics engine a game simulates with: a request (the project's setting, `?physicsBackend=`)
// resolved against what this build runs, falling back to cannon with a stated reason.

describe('choosing a physics backend', () => {
    it('runs cannon when asked, or when nothing is asked, and Rapier when asked', () => {
        expect(resolvePhysicsBackendRequest('cannon')).toEqual({ kind: 'cannon', reason: null });
        expect(resolvePhysicsBackendRequest('rapier')).toEqual({ kind: 'rapier', reason: null });
        expect(resolvePhysicsBackendRequest(undefined)).toEqual({ kind: 'cannon', reason: null });
        expect(resolvePhysicsBackendRequest('')).toEqual({ kind: 'cannon', reason: null });
    });

    it('falls back to cannon, saying why, for a backend this build does not run', () => {
        expect(resolvePhysicsBackendRequest('jolt')).toEqual({ kind: 'cannon', reason: 'the Jolt backend is not implemented yet' });
        const unknown = resolvePhysicsBackendRequest('havok');
        expect(unknown.kind).toBe('cannon');
        expect(unknown.reason).toMatch(/havok/);
    });

    it('lists every backend a project may name, the implemented ones runnable', () => {
        expect(PHYSICS_BACKENDS.map(b => b.request)).toEqual(['cannon', 'rapier', 'jolt']);
        for (const b of PHYSICS_BACKENDS.filter(b => b.implemented)) expect(resolvePhysicsBackendRequest(b.request)).toEqual({ kind: b.request, reason: null });
    });

    it('builds the world on the resolved backend and keeps what was asked', () => {
        const asked = new PhysicsSystem({ backend: 'jolt' });
        expect(asked.capabilities).toBeNull();
        asked.initialize();
        expect(asked.backend).toBe('cannon');
        expect(asked.requestedBackend).toBe('jolt');
        expect(asked.backendFallbackReason).toMatch(/not implemented/);
        expect(asked.capabilities!.backend).toBe('cannon');
        expect(describePhysicsCapabilities(asked.capabilities!)).toMatch(/^physics cannon · /);

        const plain = new PhysicsSystem();
        plain.initialize();
        expect([plain.backend, plain.requestedBackend, plain.backendFallbackReason]).toEqual(['cannon', 'cannon', null]);
    });

    it('loads a backend before building its world, and cannon needs no loading', async () => {
        expect(isPhysicsBackendLoaded('cannon')).toBe(true);
        expect((await acquirePhysicsWorld('cannon', [0, -9.81, 0])).backend).toBe('cannon');
        const p = new PhysicsSystem({ backend: 'cannon' });
        const loading = p.load();
        expect(p.load()).toBe(loading);          // once
        await loading;
        p.initialize();
        expect([p.backend, p.backendFallbackReason]).toEqual(['cannon', null]);
    });

    it('loads Rapier first, and builds its world once loaded', async () => {
        const p = new PhysicsSystem({ backend: 'rapier' });
        await p.load();
        p.initialize();
        expect([p.backend, p.requestedBackend, p.backendFallbackReason]).toEqual(['rapier', 'rapier', null]);
        expect(describePhysicsCapabilities(p.capabilities!)).toMatch(/^physics rapier · capsule native · /);
    });

    it("loads Jolt's library on demand", async () => {
        await acquirePhysicsBackend('jolt');
        expect(isPhysicsBackendLoaded('jolt')).toBe(true);
    });
});
