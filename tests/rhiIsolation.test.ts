import { describe, it, expect } from 'vitest';
import { BOUNDARY_ALLOWED, boundaryHits, boundaryOffenders } from './helpers/rhiBoundary';

/**
 * WebGL and WebGPU live in `src/graphics/rhi/webgl2/` and `src/graphics/rhi/webgpu/`, and nowhere else.
 * The renderer, the scene, the editor and the creator talk to the RHI interfaces only — see
 * tests/helpers/rhiBoundary.ts for what counts as a breach and why each rule exists, and
 * `BOUNDARY_ALLOWED` there for the few files that sit ON the boundary (the device factory, the public
 * re-exports, the WebGL handle typings).
 */
const ROOTS = ['src', 'applications/app-kit/src', 'applications/editor/src', 'applications/creator/src'];

describe('the RHI boundary', () => {
    const { scanned, offenders } = boundaryOffenders(ROOTS);

    it('scans the whole tree', () => {
        // A walk that silently finds nothing would pass every assertion below.
        expect(scanned).toBeGreaterThan(300);
    });

    it('no file outside the backends talks to WebGL or WebGPU beyond what it is allowed', () => {
        const breaches: string[] = [];
        for (const [file, hits] of offenders) {
            const allowed = new Set(BOUNDARY_ALLOWED[file] ?? []);
            const extra = hits.filter(h => !allowed.has(h));
            if (extra.length) breaches.push(`${file}: ${extra.join(', ')}`);
        }
        expect(breaches, 'Go through the RHI interfaces (rhi/device.ts) instead — see tests/helpers/rhiBoundary.ts').toEqual([]);
    });

    it('every allowance is still needed', () => {
        // An allowance outliving its reason is a hole the next breach walks through unnoticed.
        const stale: string[] = [];
        for (const [file, rules] of Object.entries(BOUNDARY_ALLOWED)) {
            const hits = new Set(offenders.get(file) ?? []);
            const unused = rules.filter(r => !hits.has(r));
            if (unused.length) stale.push(`${file}: ${unused.join(', ')}`);
        }
        expect(stale, 'Remove these from BOUNDARY_ALLOWED').toEqual([]);
    });

    it('reads code, not comments or messages', () => {
        // Comments and string contents never count; import paths and context names do.
        expect(boundaryHits('// gl.enable(gl.BLEND)\nconst s = "navigator.gpu and gl.x";\nconst n = 1;')).toEqual([]);
        expect(boundaryHits('const re = /\\/\\//; gl.viewport(0, 0, 1, 1);')).toEqual(['gl']);
        expect(boundaryHits("import { x } from '../rhi/webgl2/glContext';")).toEqual(['backendImport']);
        // Resolved against the importing file: from inside rhi/, './webgl2/' is the backend too.
        expect(boundaryHits("import { x } from './webgl2/glContext';", 'src/graphics/rhi/thing.ts')).toEqual(['backendImport']);
        expect(boundaryHits("import { x } from './glContext';", 'src/graphics/thing.ts')).toEqual([]);
        expect(boundaryHits("canvas.getContext('webgl2');")).toEqual(['getContext']);
        expect(boundaryHits('if (device.backend === "webgpu") flip();')).toEqual(['backendName']);
        expect(boundaryHits('const t = `${gl.FLOAT}`;')).toEqual(['gl']);
    });
});
