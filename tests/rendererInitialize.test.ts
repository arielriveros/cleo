import { describe, it, expect, afterEach, vi } from 'vitest';
import { Renderer } from '../src/graphics/renderer';
import { setParticleSimVariants } from '../src/graphics/particles/particleRenderer';

/**
 * `Renderer.initialize()` is re-entrant-safe.
 *
 * There is no GPU here and there never will be — this suite is DOM-free by design — so what is testable
 * is the control flow around acquisition. The canvas is stubbed to return NO context, so acquisition
 * fails immediately on the WebGL2 branch; that deterministic failure is the lever that makes the
 * shared-promise identity observable without a driver.
 */

/** A `document` with just enough on it for the Renderer constructor. */
function stubCanvas(getContext: () => unknown) {
    vi.stubGlobal('document', { createElement: () => ({ getContext, style: {} }) });
}

describe('Renderer.initialize concurrency', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('hands two overlapping callers the SAME promise', async () => {
        stubCanvas(() => null);
        const renderer = new Renderer({});

        // Called back to back, with no await in between — the interleaving that becomes ordinary the
        // moment acquisition awaits an adapter, and that `_deviceReady` alone cannot see: it is still
        // false when the second call arrives.
        const first = renderer.initialize();
        const second = renderer.initialize();
        expect(second).toBe(first);

        await expect(first).rejects.toThrow('WebGL context not available');
        await expect(second).rejects.toThrow('WebGL context not available');
    });

    it('retries after a failure rather than replaying the first error', async () => {
        // The guard clears on rejection as well as resolution. If it did not, a host that retried after
        // a transient acquisition failure would get the original error forever, from a promise that
        // never ran anything again.
        let attempts = 0;
        stubCanvas(() => { attempts++; return null; });
        const renderer = new Renderer({});

        await expect(renderer.initialize()).rejects.toThrow();
        await expect(renderer.initialize()).rejects.toThrow();
        expect(attempts).toBe(2);
    });

    it('reports the request even when nothing could be acquired', async () => {
        stubCanvas(() => null);
        // 'webgpu' with no navigator.gpu resolves to the browser fallback reason and drops through to
        // the WebGL2 branch, which is the path a real user on an old browser takes.
        vi.stubGlobal('navigator', {});
        const renderer = new Renderer({ backend: 'webgpu' });
        await expect(renderer.initialize()).rejects.toThrow();

        expect(renderer.requestedBackend).toBe('webgpu');
        expect(renderer.backendFallbackReason).toBe('this browser does not expose navigator.gpu');
    });
});

describe('Renderer.preInitializeAsync', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    /** A renderer past device acquisition, with the GPU halves of program building stubbed out. */
    function stubbed() {
        stubCanvas(() => null);
        const renderer = new Renderer({}) as any;
        renderer._deviceReady = true;
        renderer._configureDefaultState = () => {};
        renderer._createTargets = vi.fn();
        const built: string[] = [];
        renderer._buildProgram = (entry: readonly [string, unknown]) => { built.push(entry[0]); };
        return { renderer, built };
    }

    it('builds the same programs, in the same order, as the synchronous path', async () => {
        const sync = stubbed();
        sync.renderer.preInitialize();
        const async_ = stubbed();
        await async_.renderer.preInitializeAsync();
        expect(async_.built).toEqual(sync.built);
        expect(async_.built.length).toBeGreaterThan(40);
        expect(async_.renderer._createTargets).toHaveBeenCalledTimes(1);
    });

    it('reports every program, ending at total / total', async () => {
        const { renderer, built } = stubbed();
        const reports: [number, number][] = [];
        await renderer.preInitializeAsync((done: number, total: number) => reports.push([done, total]));
        const total = built.length;
        expect(reports[0]).toEqual([0, total]);
        expect(reports.at(-1)).toEqual([total, total]);
        expect(reports).toHaveLength(total + 1);
        for (let i = 1; i < reports.length; i++) expect(reports[i][0]).toBe(reports[i - 1][0] + 1);
    });

    it('builds only a published list, as variants, in table order', async () => {
        stubCanvas(() => null);
        const renderer = new Renderer({ programs: ['particleSim~s15', 'screen', 'pbr~pcf', 'pbrGeometry~pom'] }) as any;
        renderer._deviceReady = true;
        renderer._configureDefaultState = () => {};
        renderer._createTargets = vi.fn();
        const built: string[] = [];
        renderer._buildProgram = (entry: readonly [string, unknown]) => { built.push(entry[0]); };
        const reports: [number, number][] = [];
        try {
            await renderer.preInitializeAsync((done: number, total: number) => reports.push([done, total]));
        } finally {
            setParticleSimVariants(false);
        }
        expect(built).toEqual(['pbr~pcf', 'pbrGeometry~pom', 'screen', 'particleSim~s15']);
        expect(reports.at(-1)).toEqual([4, 4]);
    });
});
