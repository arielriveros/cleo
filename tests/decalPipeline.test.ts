import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Where the decal passes sit in the frame, and the few lines of state each one cannot get wrong.
 *
 * Source-text scanning, for the reason every renderer contract here gives: a Renderer needs a GPU, and
 * the harness that had one is gone. Each check below guards a failure that is SILENT on at least one
 * backend — a decal the lighting never sees, a resolve that samples its own depth attachment, a cursor
 * that shimmers, bloom that breaks under a glowing decal.
 */

const CRLF = new RegExp(String.raw`\r\n`, 'g');
const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8').replace(CRLF, '\n');
const WGSL = (name: string) =>
    readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', name), 'utf-8').replace(CRLF, '\n');

/** The brace-matched body of `private [static] name(...)`. */
function methodBody(name: string): string {
    const start = RENDERER.search(new RegExp(`\\n    private (?:static )?${name}\\(`));
    expect(start, `${name} not found in renderer.ts`).toBeGreaterThan(-1);
    const open = RENDERER.indexOf('{', RENDERER.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < RENDERER.length; i++) {
        if (RENDERER[i] === '{') depth++;
        else if (RENDERER[i] === '}' && --depth === 0) return RENDERER.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
}

/** The literal a `private static readonly NAME: BlendState = {...}` declares. */
function blendState(name: string): string {
    const at = RENDERER.indexOf(`private static readonly ${name}: BlendState = {`);
    expect(at, `${name} not declared`).toBeGreaterThan(-1);
    return RENDERER.slice(at, RENDERER.indexOf('};', at));
}

describe('surface decals', () => {
    it('resolve into the G-buffer after it is drawn and before SSAO and lighting read it', () => {
        const body = methodBody('_renderDeferred');
        const geometry = body.indexOf('this._geometryPass(scene)');
        const decals = body.indexOf('this._surfaceDecalPass()');
        const ssao = body.indexOf('this._ssaoPass()');
        const lighting = body.indexOf('this._deferredLightingPass(');
        expect(geometry).toBeGreaterThan(-1);
        expect(decals).toBeGreaterThan(geometry);
        expect(ssao).toBeGreaterThan(decals);
        expect(lighting).toBeGreaterThan(decals);
    });

    it('set the pipeline per decal, which is what resets WebGL2 texture units', () => {
        const body = methodBody('_surfaceDecalPass');
        const loop = body.indexOf('for (const decal of this._surfaceDecals)');
        expect(loop).toBeGreaterThan(-1);
        expect(body.indexOf('pass.setPipeline(pipeline)', loop)).toBeGreaterThan(loop);
    });

    it('clear every DBuffer attachment, not attachment 0 alone', () => {
        // A named clear value clears one attachment unless asked otherwise; stale normals or roughness in
        // targets 1 and 2 would resolve into every lit pixel.
        expect(methodBody('_surfaceDecalPass'))
            .toMatch(/_beginFullscreenPass\(dbuffer\.renderTarget, 'decals', true, \[0, 0, 0, 1\], false, true\)/);
    });

    it('never let the resolve sample the depth attached to its own pass', () => {
        const body = methodBody('_surfaceDecalPass');
        const resolve = body.slice(body.indexOf("'decals.resolve'"));
        expect(resolve).not.toMatch(/gBuffer\.depth|_gBufferFBO\.depth/);
        expect(WGSL('decalResolve.wgsl')).not.toMatch(/texture_depth_2d/);
    });

    it('copy the G-buffer through the frame encoder, as a depth copy does', () => {
        const body = methodBody('_copyColors');
        expect(body).toContain("this._acquireEncoder('copyColor')");
        expect(body).toContain('if (encoder !== this._frameEncoder) encoder.finish()');
        expect(body).not.toContain('device.createCommandEncoder');
    });

    it('blend all three targets alike, keeping the surviving fraction of the surface in alpha', () => {
        const blend = blendState('_DECAL_DBUFFER_BLEND');
        expect(blend).toMatch(/color: \{ srcFactor: 'one', dstFactor: 'one-minus-src-alpha'/);
        expect(blend).toMatch(/alpha: \{ srcFactor: 'zero', dstFactor: 'one-minus-src-alpha'/);
    });
});

describe('emissive decals', () => {
    it('add light without touching the bloom mask in the scene alpha', () => {
        const blend = blendState('_DECAL_EMISSIVE_BLEND');
        expect(blend).toMatch(/color: \{ srcFactor: 'one', dstFactor: 'one'/);
        expect(blend).toMatch(/alpha: \{ srcFactor: 'zero', dstFactor: 'one'/);
    });

    it('run after the opaque depth snapshot, in both pipelines', () => {
        for (const method of ['_renderForwardOverlay', '_renderScene']) {
            const body = methodBody(method);
            const snapshot = body.indexOf('this._copySceneDepth()');
            const emissive = body.indexOf('this._emissiveDecalPass()');
            expect(snapshot, method).toBeGreaterThan(-1);
            expect(emissive, method).toBeGreaterThan(snapshot);
        }
    });
});

describe('editor-only decals', () => {
    it('draw in the overlay layer, reconstructed with the STABLE inverse view-projection', () => {
        const body = methodBody('_renderEditorOverlay');
        expect(body).toMatch(/_drawColorDecals\(decalPass, this\._overlayDecals, OVERLAY_BLEND, this\._invViewProjStable, 1\)/);
        // Before the helpers, so a selected node's wireframe still draws over the brush.
        expect(body.indexOf("'overlay.decals'")).toBeLessThan(body.indexOf("'overlay.helpers'"));
    });

    it('are routed by the editor-only flag, and never drawn into a thumbnail', () => {
        const body = methodBody('_collectDecals');
        expect(body).toContain('isEditorOnlyNode(decal)');
        expect(body).toMatch(/if \(this\._thumbnailMode\) continue;/);
    });
});

describe('the receiver filter', () => {
    it('draws its depth before the scene, inside the jittered phase', () => {
        const frame = methodBody('_renderFrame');
        const receivers = frame.indexOf('this._decalReceiverPass(scene)');
        expect(frame.indexOf('this._collectDecals(scene)')).toBeLessThan(receivers);
        expect(receivers).toBeLessThan(frame.indexOf('this._renderDeferred('));
        expect(receivers).toBeLessThan(frame.indexOf('this._renderForward('));
        expect(methodBody('_decalReceiverPass')).toContain('this._rasterProjection(cam.projectionMatrix)');
    });

    it('draws nothing, rather than everything, for a terrain decal whose receiver depth is missing', () => {
        const body = methodBody('_decalReceiverDepth');
        expect(body).toMatch(/return this\._decalReceiversReady && this\._decalReceiverFBO \? this\._decalReceiverFBO\.depth : null;/);
        for (const method of ['_surfaceDecalPass', '_drawColorDecals'])
            expect(methodBody(method), method).toMatch(/if \(!receivers\) continue;/);
    });
});

describe('the decal box', () => {
    it('is drawn as its back faces, flipping the cull for a mirrored transform', () => {
        expect(methodBody('_decalCull')).toContain("return decal.mirrored ? 'back' : 'front';");
    });

    it('is the shared position-only cube, drawn with the layout it was built for', () => {
        for (const method of ['_surfaceDecalPass', '_drawColorDecals'])
            expect(methodBody(method), method).toContain("builtFor: 'irradiance'");
    });
});

describe('the programs', () => {
    it('are appended at the end of the program table', () => {
        const table = methodBody('_createPrograms');
        const entries = [...table.matchAll(/\['(\w+)',\s+\w+Program\]/g)].map(m => m[1]);
        expect(entries.slice(-3)).toEqual(['decalSurface', 'decalResolve', 'decalColor']);
    });

    it('never discard in the box passes, which keeps them in uniform control flow', () => {
        for (const file of ['decalSurface.wgsl', 'decalColor.wgsl', 'chunks/decal.wgsl'])
            expect(WGSL(file).replace(/\/\/[^\n]*/g, ''), file).not.toMatch(/\bdiscard\b/);
    });
});
