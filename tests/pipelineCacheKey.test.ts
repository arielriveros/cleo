import { describe, it, expect } from 'vitest';
import { PipelineCache, DEPTH_ALWAYS, DEPTH_TEST, DEPTH_WRITE } from '../src/graphics/render/pipelineCache';
import type { BlendState, DepthStencilState } from '../src/graphics/rhi/types';

/**
 * The pipeline cache key is a published contract: a game ships the recipes its editor session recorded
 * (`config.graphics.pipelines`), and the player warms each one under this key so the first draw that wants
 * it finds it built. `get` and the warm-up share one key function; this pins its spelling, so a reworded
 * field (which would make every shipped recipe miss, silently) fails here first.
 */
const keyOf = (PipelineCache as unknown as { _keyOf: (...args: unknown[]) => string })._keyOf;

const depth: DepthStencilState = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' };
const blend: BlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

describe('the pipeline cache key', () => {
    it('spells a G-buffer pipeline the way published recipes were recorded', () => {
        expect(keyOf('pbrGeometry', 'back', 3, 'triangle-list', 'model', 'pbr', false, false,
                     'rgba16float,rgba16float,rgba16float', null, depth, true))
            .toBe('pbrGeometry|back|3|triangle-list|model|pbr|rgba16float,rgba16float,rgba16float|depth24pluswless-equal:0:0');
    });

    it('carries the winding, a split vertex stage, the blend and a depth-only write mask', () => {
        expect(keyOf('basic', 'none', 1, 'triangle-list', false, null, true, true, 'rgba8unorm', blend, null, false))
            .toBe('basic|none|1|triangle-list|false||cw|vs|rgba8unorm|src-alphaone-minus-src-alphaadd/oneone-minus-src-alphaadd|nc');
    });

    it('spells the shared depth constants exactly as the literals they replaced', () => {
        // The draw paths pass DEPTH_WRITE / DEPTH_TEST instead of a literal per draw (so the key memo hits);
        // a recipe recorded with the literal must still be found by the constant.
        const literalTest: DepthStencilState = { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' };
        const args = ['pbr', 'back', 1, 'triangle-list', 'model', 'pbr', false, false, 'rgba16float', null] as const;
        expect(keyOf(...args, DEPTH_WRITE, true)).toBe(keyOf(...args, depth, true));
        expect(keyOf(...args, DEPTH_TEST, true)).toBe(keyOf(...args, literalTest, true));
    });

    it('keeps the always-on-top state from writing the depth it borrows', () => {
        // Gizmos and the selection silhouette draw through geometry into the scene's own depth attachment,
        // which game sprites are still tested against later in the frame.
        expect(DEPTH_ALWAYS.depthWriteEnabled).toBe(false);
        expect(DEPTH_ALWAYS.depthCompare).toBe('always');
    });
});
