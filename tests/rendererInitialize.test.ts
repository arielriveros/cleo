import { describe, it, expect, afterEach, vi } from 'vitest';
import { Renderer } from '../src/graphics/renderer';

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
