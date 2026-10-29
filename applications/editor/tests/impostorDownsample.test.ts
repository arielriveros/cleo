import { describe, it, expect } from 'vitest'
import { downsampleCoverage } from '../src/utils/modelThumbnails'

// An impostor is captured at up to 4x and box-filtered down with coverage weighting. The capture's alpha
// is binary (from depth), so this is what turns stair-stepped needle edges into fractional coverage —
// without letting the transparent background's (black) colour into the edge texels.
describe('downsampleCoverage', () => {
  const px = (rgba: number[][]) => Uint8ClampedArray.from(rgba.flat())

  it('alpha is the fraction covered; colour is the mean of only the covered samples', () => {
    // A 2x2 block: one green covered sample, three transparent black ones.
    const out = downsampleCoverage(px([[0, 200, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), 2, 2, 2)
    expect(out.width).toBe(1)
    expect([...out.data]).toEqual([0, 200, 0, 64])
  });

  it('a fully covered block keeps its exact average colour and full alpha', () => {
    const out = downsampleCoverage(px([[10, 20, 30, 255], [30, 40, 50, 255], [10, 20, 30, 255], [30, 40, 50, 255]]), 2, 2, 2)
    expect([...out.data]).toEqual([20, 30, 40, 255])
  });

  it('an empty block stays empty', () => {
    const out = downsampleCoverage(px([[9, 9, 9, 0], [9, 9, 9, 0], [9, 9, 9, 0], [9, 9, 9, 0]]), 2, 2, 2)
    expect(out.data[3]).toBe(0)
  });
});

