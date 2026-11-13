import { describe, it, expect } from 'vitest';
import { RENDER_2D_DEFAULTS, RENDER_3D_DEFAULTS } from 'cleo';
import { dimensionLookPatch } from '../src/utils/sceneDimension';

// Switching a scene's dimension changes its look with it: the 2D look on the way in (authored pixels as
// drawn), the 3D one back on the way out, but only while the 2D look is still untouched.
describe('dimensionLookPatch', () => {
  it('gives a scene switched to 2D the 2D look, whatever it had', () => {
    expect(dimensionLookPatch({ toneMapper: 'agx', bloomMode: 'physical' }, '2D')).toEqual(RENDER_2D_DEFAULTS);
  });

  it('gives back the 3D look when the 2D one was never retuned', () => {
    expect(dimensionLookPatch({ ...RENDER_2D_DEFAULTS, bloomIntensity: 0.5 }, '3D')).toEqual(RENDER_3D_DEFAULTS);
  });

  it('keeps a 2D look the artist retuned', () => {
    expect(dimensionLookPatch({ ...RENDER_2D_DEFAULTS, toneMapper: 'neutral' }, '3D')).toBeNull();
  });
});
