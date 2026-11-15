import type { BlendState } from '../rhi/types';

/**
 * Premultiplied "over" into the scene buffer, alpha included: ONE, ONE_MINUS_SRC_ALPHA on both colour and
 * alpha. The volumetric clouds (and the sky's cloud bake) and the smoke-and-fire volumes composite with it:
 * they are bloom-eligible, so their coverage goes into the mask alpha instead of the default mask-preserving
 * blend, and their shaders output premultiplied colour. A leaf, so neither feature loads the other for it.
 */
export const CLOUD_BLEND: BlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
