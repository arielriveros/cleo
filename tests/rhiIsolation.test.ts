import { describe, it, expect } from 'vitest';
import { BOUNDARY_ALLOWED, boundaryHits, boundaryOffenders } from './helpers/rhiBoundary';

/**
 * WebGL and WebGPU live in `src/graphics/rhi/webgl2/` and `src/graphics/rhi/webgpu/`, and nowhere else.
 * The renderer, the scene, the editor and the creator talk to the RHI interfaces only — see
 * tests/helpers/rhiBoundary.ts for what counts as a breach and why each rule exists.
 *
 * `MIGRATING` is the ratchet while the refactor that sealed the boundary is in flight: each file still
 * allowed to break a rule, and which. A file may not break a rule it is not listed for, and a listed
 * file that has been cleaned must come OFF the list in the same change — so the list only ever shrinks.
 */
const MIGRATING: Readonly<Record<string, readonly string[]>> = {
    'src/core/scene/nodes/fluidVolumeNode.ts': ['backendName'],
    'src/graphics/gpuProfiler.ts': ['gl', 'WebGLType', 'backendImport', 'backendName'],
    'src/graphics/particles/particleRenderer.ts': ['backendName'],
    'src/graphics/render/capture.ts': ['backendName'],
    'src/graphics/render/foliage.ts': ['backendName'],
    'src/graphics/render/lighting.ts': ['backendName'],
    'src/graphics/render/pipelineCache.ts': ['backendName'],
    'src/graphics/render/shadows.ts': ['backendName'],
    'src/graphics/render/sky.ts': ['backendName'],
    'src/graphics/render/viewProjection.ts': ['backendName'],
    'src/graphics/renderer.ts': ['backendName'],
    'src/graphics/systems/customShaders.ts': ['backendImport', 'backendName'],
    'src/graphics/systems/texturePacker.ts': ['backendName'],
};

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
            const allowed = new Set([...(BOUNDARY_ALLOWED[file] ?? []), ...(MIGRATING[file] ?? [])]);
            const extra = hits.filter(h => !allowed.has(h));
            if (extra.length) breaches.push(`${file}: ${extra.join(', ')}`);
        }
        expect(breaches, 'Go through the RHI interfaces (rhi/device.ts) instead — see tests/helpers/rhiBoundary.ts').toEqual([]);
    });

    it('the migration list only shrinks: a cleaned file comes off it', () => {
        const stale: string[] = [];
        for (const [file, rules] of Object.entries(MIGRATING)) {
            const hits = new Set(offenders.get(file) ?? []);
            const clean = rules.filter(r => !hits.has(r));
            if (clean.length) stale.push(`${file}: ${clean.join(', ')}`);
        }
        expect(stale, 'Remove these entries from MIGRATING').toEqual([]);
    });

    it('reads code, not comments or messages', () => {
        // Comments and string contents never count; import paths and context names do.
        expect(boundaryHits('// gl.enable(gl.BLEND)\nconst s = "navigator.gpu and gl.x";\nconst n = 1;')).toEqual([]);
        expect(boundaryHits('const re = /\\/\\//; gl.viewport(0, 0, 1, 1);')).toEqual(['gl']);
        expect(boundaryHits("import { x } from '../rhi/webgl2/glContext';")).toEqual(['backendImport']);
        expect(boundaryHits("canvas.getContext('webgl2');")).toEqual(['getContext']);
        expect(boundaryHits('if (device.backend === "webgpu") flip();')).toEqual(['backendName']);
        expect(boundaryHits('const t = `${gl.FLOAT}`;')).toEqual(['gl']);
    });
});
