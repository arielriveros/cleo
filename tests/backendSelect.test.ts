import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveBackendRequest, webgpuAcquisitionAllowed, WEBGPU_IMPLEMENTED } from '../src/graphics/rhi/backendSelect';

/**
 * The backend request truth table.
 *
 * Worth a test rather than a read-through because the two "no" answers mean opposite things to whoever
 * asked — "your browser has no WebGPU" is the user's to fix, "not implemented yet" is ours — and the
 * probe hatch adds a third input that must NOT be able to turn the first one into a yes. A device is
 * never acquired here; this is the pure decision, which is exactly the part that can be tested without
 * a GPU.
 *
 * `navigator` and `window` are stubbed rather than assumed: Node 20 has a real global `navigator` with
 * no `gpu` on it, so the "no WebGPU" arm passes by accident there and the "has WebGPU" arm is
 * unreachable without a stub.
 */

/** A browser-shaped global pair. `search` is the raw query string, as `location.search` gives it. */
function browser(options: { gpu?: boolean; search?: string; probeFlag?: boolean } = {}) {
    vi.stubGlobal('navigator', options.gpu ? { gpu: {} } : {});
    vi.stubGlobal('window', {
        location: { search: options.search ?? '' },
        ...(options.probeFlag === undefined ? {} : { __CLEO_WEBGPU_PROBE: options.probeFlag }),
    });
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
        // Order matters and is not interchangeable: with the hatch open and no WebGPU in the browser,
        // the honest answer is still the browser's, and acquisition would fail if we said otherwise.
        browser({ gpu: false, probeFlag: true });
        expect(resolveBackendRequest('webgpu')).toBe(NOT_IN_BROWSER);
    });

    it('refuses WebGPU only while the build says it cannot draw through one', () => {
        // Asserted against WEBGPU_IMPLEMENTED rather than a hardcoded refusal, because that constant is
        // exactly the thing being tested: while it is false a browser with WebGPU is still turned away,
        // and once the renderer really does draw through one, flipping it must let the request through
        // without editing this expectation. A test that has to be rewritten to flip a flag is measuring
        // the flag's current value, not the rule.
        browser({ gpu: true });
        expect(resolveBackendRequest('webgpu')).toBe(WEBGPU_IMPLEMENTED ? null : NOT_IMPLEMENTED);
    });

    it('allows WebGPU through the ?cleoWebgpuProbe=1 hatch', () => {
        browser({ gpu: true, search: '?scene=full&cleoWebgpuProbe=1' });
        expect(resolveBackendRequest('webgpu')).toBeNull();
    });

    it('allows WebGPU through the window.__CLEO_WEBGPU_PROBE hatch', () => {
        browser({ gpu: true, probeFlag: true });
        expect(resolveBackendRequest('webgpu')).toBeNull();
    });

    it('does not open on a truthy-but-wrong hatch value', () => {
        // `=== '1'` and `=== true`, not truthiness: `?cleoWebgpuProbe=0` reads as the string '0', which
        // is truthy in JS and would otherwise turn "off" into "on".
        //
        // The claim is that a wrong hatch value behaves EXACTLY like no hatch at all, so it is asserted
        // against whatever the no-hatch answer currently is. That keeps the test about the hatch even
        // once WEBGPU_IMPLEMENTED makes the request succeed for unrelated reasons.
        const closed = WEBGPU_IMPLEMENTED ? null : NOT_IMPLEMENTED;
        browser({ gpu: true, search: '?cleoWebgpuProbe=0' });
        expect(resolveBackendRequest('webgpu')).toBe(closed);
        browser({ gpu: true, search: '?cleoWebgpuProbe' });
        expect(resolveBackendRequest('webgpu')).toBe(closed);
    });
});

describe('webgpuAcquisitionAllowed', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('is false with no window at all', () => {
        // The published-build and worker cases. Guarded because reading `window.location` off undefined
        // would throw where a plain "no" is the answer.
        vi.stubGlobal('window', undefined);
        expect(webgpuAcquisitionAllowed()).toBe(WEBGPU_IMPLEMENTED);
    });

    it('is independent of navigator.gpu — it answers about the BUILD, not the browser', () => {
        browser({ gpu: false, probeFlag: true });
        expect(webgpuAcquisitionAllowed()).toBe(true);
    });

    it('stays shut by default so no user is offered a backend that cannot draw', () => {
        browser({ gpu: true });
        expect(webgpuAcquisitionAllowed()).toBe(WEBGPU_IMPLEMENTED);
    });
});
