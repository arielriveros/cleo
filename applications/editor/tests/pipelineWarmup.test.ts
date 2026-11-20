import { describe, it, expect } from 'vitest';
import { mergeRecipes } from '../src/utils/pipelineWarmup';

// What the editor remembers of a project's WebGPU pipelines between sessions, for the next one to warm.

describe('mergeRecipes', () => {
    const a = { program: 'pbr', cullMode: 'back' }, b = { program: 'water' }, c = { program: 'pbrGeometry' };

    it('keeps one of each recipe, this session first, then what earlier ones built and this one did not', () => {
        expect(mergeRecipes([b, { ...a }], [a, c])).toEqual([a, c, b]);
    });

    it('stops at the cap, dropping the oldest', () => {
        expect(mergeRecipes([b, c], [a], 2)).toEqual([a, b]);
    });
});
