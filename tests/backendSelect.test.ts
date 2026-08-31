import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveBackendRequest, webgpuAvailableInBrowser, WEBGPU_IMPLEMENTED } from '../src/graphics/rhi/backendSelect';

/**
 * The backend request truth table.
 *
 * Worth a test rather than a read-through because the two "no" answers mean opposite things to whoever
 * asked — "your browser has no WebGPU" is the user's to fix, "not implemented yet" is ours. A device is
 * never acquired here; this is the pure decision, which is exactly the part that can be tested without
 * a GPU.
 *
 * `navigator` is stubbed rather than assumed: Node 20 has a real global `navigator` with no `gpu` on
 * it, so the "no WebGPU" arm passes by accident there and the "has WebGPU" arm is unreachable without
 * a stub.
 */

/** A browser-shaped global. */
function browser(options: { gpu?: boolean } = {}) {
    vi.stubGlobal('navigator', options.gpu ? { gpu: {} } : {});
}

const NOT_IN_BROWSER = 'this browser does not expose navigator.gpu';
const NOT_IMPLEMENTED = 'the WebGPU device works, but the renderer does not draw through it yet';

describe('resolveBackendRequest', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('honours an absent or explicit WebGL2 request without asking anything else', () => {
        browser({ gpu: false });
        expect(resolveBackendRequest(undefined)).toBeNull();
        expect(resolveBackendRequest('webgl2')).toBeNull();
    });

    it('answers "no navigator.gpu" before "not implemented"', () => {
        // Order matters and is not interchangeable: with no WebGPU in the browser the honest answer is
        // the browser's, and acquisition would fail if we said otherwise.
        browser({ gpu: false });
        expect(resolveBackendRequest('webgpu')).toBe(NOT_IN_BROWSER);
    });

    it('refuses WebGPU only while the build says it cannot draw through one', () => {
        // Asserted against WEBGPU_IMPLEMENTED rather than a hardcoded answer, because that constant is
        // exactly the thing being tested: while it is false a browser with WebGPU is still turned away,
        // and once the renderer really does draw through one, flipping it must let the request through
        // without editing this expectation. A test that has to be rewritten to flip a flag is measuring
        // the flag's current value, not the rule.
        browser({ gpu: true });
        expect(resolveBackendRequest('webgpu')).toBe(WEBGPU_IMPLEMENTED ? null : NOT_IMPLEMENTED);
    });
});

describe('webgpuAvailableInBrowser', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('reports the surface only', () => {
        browser({ gpu: true });
        expect(webgpuAvailableInBrowser()).toBe(true);
        browser({ gpu: false });
        expect(webgpuAvailableInBrowser()).toBe(false);
    });

    it('is false with no navigator at all', () => {
        // The published-build and worker cases. Guarded because reading `gpu` off undefined would throw
        // where a plain "no" is the answer.
        vi.stubGlobal('navigator', undefined);
        expect(webgpuAvailableInBrowser()).toBe(false);
    });
});
