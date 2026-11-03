import { describe, it, expect } from 'vitest';
import { PHYSICS_BACKENDS, resolvePhysicsBackendRequest } from '../src/physics/pal/backendSelect';
import { describePhysicsCapabilities } from '../src/physics/pal/capabilities';
import { PhysicsSystem } from '../src/physics/physicsSystem';

// Which physics engine a game simulates with: a request (the project's setting, `?physicsBackend=`)
// resolved against what this build runs, falling back to cannon with a stated reason.

describe('choosing a physics backend', () => {
    it('runs cannon when asked, or when nothing is asked', () => {
        expect(resolvePhysicsBackendRequest('cannon')).toEqual({ kind: 'cannon', reason: null });
        expect(resolvePhysicsBackendRequest(undefined)).toEqual({ kind: 'cannon', reason: null });
        expect(resolvePhysicsBackendRequest('')).toEqual({ kind: 'cannon', reason: null });
    });

    it('falls back to cannon, saying why, for a backend this build does not run', () => {
        const rapier = resolvePhysicsBackendRequest('rapier');
        expect(rapier.kind).toBe('cannon');
        expect(rapier.reason).toMatch(/Rapier.*not implemented/);
        const unknown = resolvePhysicsBackendRequest('havok');
        expect(unknown.kind).toBe('cannon');
        expect(unknown.reason).toMatch(/havok/);
    });

    it('lists every backend a project may name, the implemented ones runnable', () => {
        expect(PHYSICS_BACKENDS.map(b => b.request)).toEqual(['cannon', 'rapier']);
        for (const b of PHYSICS_BACKENDS.filter(b => b.implemented)) expect(resolvePhysicsBackendRequest(b.request)).toEqual({ kind: b.request, reason: null });
    });

    it('builds the world on the resolved backend and keeps what was asked', () => {
        const asked = new PhysicsSystem({ backend: 'rapier' });
        expect(asked.capabilities).toBeNull();
        asked.initialize();
        expect(asked.backend).toBe('cannon');
        expect(asked.requestedBackend).toBe('rapier');
        expect(asked.backendFallbackReason).toMatch(/not implemented/);
        expect(asked.capabilities!.backend).toBe('cannon');
        expect(describePhysicsCapabilities(asked.capabilities!)).toMatch(/^physics cannon · /);

        const plain = new PhysicsSystem();
        plain.initialize();
        expect([plain.backend, plain.requestedBackend, plain.backendFallbackReason]).toEqual(['cannon', 'cannon', null]);
    });
});
