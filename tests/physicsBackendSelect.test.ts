import { describe, it, expect } from 'vitest';
import { DEFAULT_PHYSICS_BACKEND, FALLBACK_PHYSICS_BACKEND, PHYSICS_BACKENDS, resolvePhysicsBackendRequest } from '../src/physics/pal/backendSelect';
import { describePhysicsCapabilities } from '../src/physics/pal/capabilities';
import { acquirePhysicsWorld, isPhysicsBackendLoaded } from '../src/physics/pal/createWorld';
import { PhysicsSystem } from '../src/physics/physicsSystem';

// Which physics engine a game simulates with: a request (the project's setting, `?physicsBackend=`)
// resolved against what this build runs. Jolt when nothing (or nothing runnable) is asked; cannon, the one
// backend that needs no loading, when the one resolved could not be loaded.

describe('choosing a physics backend', () => {
    // First: until a test loads them, Jolt and Rapier are not loaded in this file's module graph.
    it('builds on cannon, saying why, when the backend asked for was never loaded', () => {
        expect(isPhysicsBackendLoaded('jolt')).toBe(false);
        const plain = new PhysicsSystem();
        plain.initialize();
        expect(plain.backend).toBe('cannon');
        expect(plain.backendFallbackReason).toMatch(/the jolt backend was not loaded/);

        // Both reasons, when the request named no backend at all and the default was not loaded either.
        const unknown = new PhysicsSystem({ backend: 'havok' });
        unknown.initialize();
        expect([unknown.backend, unknown.requestedBackend]).toEqual(['cannon', 'havok']);
        expect(unknown.backendFallbackReason).toMatch(/no physics backend called "havok", and the jolt backend was not loaded/);
    });

    it('runs Jolt when nothing is asked, and each backend when asked', () => {
        expect(DEFAULT_PHYSICS_BACKEND).toBe('jolt');
        expect(FALLBACK_PHYSICS_BACKEND).toBe('cannon');
        expect(resolvePhysicsBackendRequest('cannon')).toEqual({ kind: 'cannon', reason: null });
        expect(resolvePhysicsBackendRequest('rapier')).toEqual({ kind: 'rapier', reason: null });
        expect(resolvePhysicsBackendRequest('jolt')).toEqual({ kind: 'jolt', reason: null });
        expect(resolvePhysicsBackendRequest(undefined)).toEqual({ kind: 'jolt', reason: null });
        expect(resolvePhysicsBackendRequest('')).toEqual({ kind: 'jolt', reason: null });
    });

    it('runs the default, saying why, for a backend this build does not run', () => {
        const unknown = resolvePhysicsBackendRequest('havok');
        expect(unknown.kind).toBe('jolt');
        expect(unknown.reason).toMatch(/havok/);
    });

    it('lists every backend a project may name, the default first, the implemented ones runnable', () => {
        expect(PHYSICS_BACKENDS.map(b => b.request)).toEqual(['jolt', 'rapier', 'cannon']);
        for (const b of PHYSICS_BACKENDS.filter(b => b.implemented)) expect(resolvePhysicsBackendRequest(b.request)).toEqual({ kind: b.request, reason: null });
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
        expect(describePhysicsCapabilities(p.capabilities!)).toMatch(/^physics cannon · /);
    });

    it('loads Rapier first, and builds its world once loaded', async () => {
        const p = new PhysicsSystem({ backend: 'rapier' });
        await p.load();
        p.initialize();
        expect([p.backend, p.requestedBackend, p.backendFallbackReason]).toEqual(['rapier', 'rapier', null]);
        expect(describePhysicsCapabilities(p.capabilities!)).toMatch(/^physics rapier · capsule native · /);
    });

    it('loads Jolt first, and builds its world once loaded', async () => {
        const p = new PhysicsSystem({ backend: 'jolt' });
        await p.load();
        expect(isPhysicsBackendLoaded('jolt')).toBe(true);
        p.initialize();
        expect([p.backend, p.requestedBackend, p.backendFallbackReason]).toEqual(['jolt', 'jolt', null]);
        expect(describePhysicsCapabilities(p.capabilities!)).toMatch(/^physics jolt · capsule native · groups 16-bit · cone limit native · f32 · /);
    });

    it('builds a world asking for nothing, or for a backend there is none of, on Jolt once loaded', async () => {
        const plain = new PhysicsSystem();
        await plain.load();
        plain.initialize();
        expect([plain.backend, plain.requestedBackend, plain.backendFallbackReason]).toEqual(['jolt', 'jolt', null]);

        const asked = new PhysicsSystem({ backend: 'havok' });
        await asked.load();
        asked.initialize();
        expect([asked.backend, asked.requestedBackend]).toEqual(['jolt', 'havok']);
        expect(asked.backendFallbackReason).toMatch(/no physics backend called "havok"/);
    });
});
