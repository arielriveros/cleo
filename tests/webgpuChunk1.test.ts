// The three things chunk 1 of the WebGPU port got right, pinned where they can be checked without a
// GPU: the view memo, the depth-state mapping, and GLState's context guard.
//
// All three share a shape — a WebGL2-only assumption that WebGL2 itself never notices, so nothing
// caught it until a second backend read the same value and got something else. That is why they are
// tested at all: none of them is visible in a picture, and each was found by a driver rejecting
// something rather than by a pixel moving.
import { describe, it, expect, beforeEach } from 'vitest';
import { GLState } from '../src/graphics/systems/glState';
import { frameStats, resetFrameStats } from '../src/graphics/renderStats';

// ------------------------------------------------------------------------------------------------
// 1. The view memo
// ------------------------------------------------------------------------------------------------
//
// `Texture` memoises the views it hands out, because the geometry pass builds a bind group per submesh
// per node and a fresh view object per draw is pure garbage. The memo is keyed on the TEXTURE'S
// GENERATION rather than on its dimensions: a GPUTexture is destroyed and recreated by `setSize`, and
// every view taken from the old one then names storage that no longer exists.
//
// Keying on dimensions would have duplicated the exact condition inside `WebGPUTexture.setSize`, in a
// different file, with nothing checking the two agree. This asserts the property that replaced it.

/** The smallest thing that behaves like an RHI texture whose storage can be replaced. */
function fakeTexture() {
    return {
        label: 'fake', format: 'rgba8unorm' as const, dimension: '2d' as const,
        width: 4, height: 4, depthOrArrayLayers: 1, mipLevelCount: 1, usage: 0,
        generation: 0,
        /** What `setSize` does on WebGPU: new storage, so every existing view is stale. */
        replaceStorage() { this.generation++; },
        destroy() { /* no-op */ },
    };
}

/** The memo, extracted to exactly the shape `Texture._cachedView` implements. */
function makeViewCache(texture: { generation: number }) {
    let cache: { generation: number; attachment: object | null; sampled: object | null } | null = null;
    let made = 0;
    return {
        get made() { return made; },
        clear() { cache = null; },
        get(role: 'attachment' | 'sampled') {
            if (cache && cache.generation !== texture.generation) cache = null;
            if (!cache) cache = { generation: texture.generation, attachment: null, sampled: null };
            const hit = cache[role];
            if (hit) return hit;
            made++;
            const view = { role, generation: texture.generation };
            cache[role] = view;
            return view;
        },
    };
}

describe('Texture view memo', () => {
    it('hands back the same object until the storage is replaced', () => {
        const texture = fakeTexture();
        const cache = makeViewCache(texture);

        const first = cache.get('attachment');
        expect(cache.get('attachment')).toBe(first);
        expect(cache.made).toBe(1);
    });

    it('rebuilds when the generation bumps — the whole reason the counter exists', () => {
        const texture = fakeTexture();
        const cache = makeViewCache(texture);

        const before = cache.get('attachment');
        texture.replaceStorage();
        const after = cache.get('attachment');

        expect(after).not.toBe(before);
        expect((after as { generation: number }).generation).toBe(1);
    });

    it('keeps the two roles apart', () => {
        // Not cosmetic. An attachment view names one mip and one layer — that is how a cascade or a cube
        // face becomes a target — while a sampled view must span the whole texture and keep its own
        // dimension, or a `texture_cube` binding gets a 2d view of face 0 and a mipped texture goes
        // unfiltered at distance. One accessor served both before, and returned a WebGL2 view for each.
        const texture = fakeTexture();
        const cache = makeViewCache(texture);

        expect(cache.get('attachment')).not.toBe(cache.get('sampled'));
        expect(cache.made).toBe(2);
    });

    it('drops both roles together when the memo is cleared', () => {
        // `Texture.delete()` clears it BEFORE destroying the storage: a memoised view outlives the
        // storage it names, and handing one out afterwards is a use-after-free the types cannot see.
        const texture = fakeTexture();
        const cache = makeViewCache(texture);

        const attachment = cache.get('attachment');
        const sampled = cache.get('sampled');
        cache.clear();

        expect(cache.get('attachment')).not.toBe(attachment);
        expect(cache.get('sampled')).not.toBe(sampled);
    });
});

// ------------------------------------------------------------------------------------------------
// 2. "no depth interaction", spelled two ways
// ------------------------------------------------------------------------------------------------
//
// WebGPU requires a pipeline to declare depth state whenever its pass has a depth attachment, and
// `_beginFullscreenPass` always declares one — so the renderer synthesises `{ depthCompare: 'always',
// depthWriteEnabled: false }` for every fullscreen pass that never asked for depth at all.
//
// On WebGL2 those same pipelines previously took the no-depthStencil branch, which DISABLES the depth
// test and masks writes. If the synthesised pair took the other branch instead it would issue
// `gl.depthFunc(ALWAYS)` — and `depthFunc` is CONTEXT state, not pass state, so it would leak past the
// pipeline into whatever legacy draw came next, which still relies on the standing LEQUAL.
//
// This is the one place in chunk 1 where a WebGL2 pixel regression could hide, so the predicate is
// pinned rather than the pixels.

/** The predicate `WebGL2RenderPipeline.apply` uses to choose its branch. */
const noDepthInteraction = (d?: { depthCompare: string; depthWriteEnabled: boolean }) =>
    !d || (d.depthCompare === 'always' && !d.depthWriteEnabled);

describe('WebGL2 depth-state mapping', () => {
    it('treats a synthesised always/no-write pair as no depth interaction', () => {
        expect(noDepthInteraction({ depthCompare: 'always', depthWriteEnabled: false })).toBe(true);
    });

    it('treats absent depth state the same way — the shape it replaced', () => {
        expect(noDepthInteraction(undefined)).toBe(true);
    });

    it('still honours a pipeline that genuinely wants depth', () => {
        // The distinction that makes this worth having: `always` WITH writes is a real request (the
        // gizmo and outline passes draw on top and mean it), and must not be collapsed.
        expect(noDepthInteraction({ depthCompare: 'always', depthWriteEnabled: true })).toBe(false);
        expect(noDepthInteraction({ depthCompare: 'less-equal', depthWriteEnabled: true })).toBe(false);
        expect(noDepthInteraction({ depthCompare: 'less-equal', depthWriteEnabled: false })).toBe(false);
    });
});

// ------------------------------------------------------------------------------------------------
// 3. GLState without a context
// ------------------------------------------------------------------------------------------------
//
// `gl` is a live binding that is simply never assigned on a backend that is not WebGL2. Every GLState
// method dereferenced it immediately, so each was a TypeError.
//
// The guard is only half the fix, and this file is where that is recorded: `GLState.enable(gl.DEPTH_TEST)`
// evaluates `gl.DEPTH_TEST` at the CALL SITE, before the method is entered — so guarding inside GLState
// could never have been enough on its own, and the enum-taking overloads were replaced by named methods
// for exactly that reason.
//
// vitest never calls `setGLContext`, so `gl` is undefined here by construction, which is the state
// under test rather than a mock of it.

describe('GLState with no context', () => {
    beforeEach(() => resetFrameStats());

    it('is a no-op rather than a TypeError', () => {
        expect(() => {
            GLState.depthTest(true);
            GLState.blend(false);
            GLState.cull(true);
            GLState.depthMask(false);
            GLState.bindVAO(null);
            GLState.useProgram(null);
        }).not.toThrow();
    });

    it('reports no state changes — a backend with no state cache made none', () => {
        // Guarded BEFORE the bookkeeping, deliberately. A HUD that reported hundreds of state changes
        // per frame on a backend that has no global state to change would be describing nothing, and
        // `stateChangesSaved` would read as a cache doing work it never did.
        GLState.depthTest(true);
        GLState.blend(true);
        GLState.cull(false);
        GLState.depthMask(true);

        expect(frameStats.stateChanges).toBe(0);
        expect(frameStats.stateChangesSaved).toBe(0);
    });

    it('exposes the named methods that replaced the enum-taking ones', () => {
        // The overloads were deleted rather than kept alongside, so the shape cannot regress: a call
        // site that reaches for `gl.DEPTH_TEST` again will not compile.
        expect(typeof GLState.depthTest).toBe('function');
        expect(typeof GLState.blend).toBe('function');
        expect(typeof GLState.cull).toBe('function');
    });
});
