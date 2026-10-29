import { describe, expect, it } from 'vitest';
import { graphRange, snapGraphValue } from '../src/ui/CurveInput';
import { curveToGraphKeys, graphKeysToCurve } from '../src/renderer/ExposureCurveEditor';

describe('the curve graph helpers', () => {
  it('grows a view range to fit values outside it', () => {
    expect(graphRange([], -4, 20)).toEqual([-4, 20]);
    expect(graphRange([-6, 3, 22], -4, 20)).toEqual([-6, 22]);
    expect(graphRange([5], 5, 5)).toEqual([5, 6]);
  });

  it('snaps to a step, or to three decimals without one', () => {
    expect(snapGraphValue(3.26, 0.5)).toBe(3.5);
    expect(snapGraphValue(-0.1, 0.25)).toBe(0);
    expect(snapGraphValue(1.23456)).toBe(1.235);
  });
});

describe('the exposure curve as graph keys', () => {
  it('round-trips [ev, stops] keys, sorted by EV', () => {
    const curve: [number, number][] = [[8, -0.25], [0, -0.75], [4, -0.5]];
    expect(graphKeysToCurve(curveToGraphKeys(curve))).toEqual([[0, -0.75], [4, -0.5], [8, -0.25]]);
    expect(graphKeysToCurve([])).toEqual([]);
  });
});
