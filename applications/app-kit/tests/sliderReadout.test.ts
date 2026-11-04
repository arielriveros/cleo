import { describe, expect, it } from 'vitest';
import { sliderReadout } from '../src/ui/Slider';

describe('the slider readout', () => {
  it('shows as many decimals as the step, two at least and four at most', () => {
    expect(sliderReadout(0.35)).toBe('0.35');
    expect(sliderReadout(0.0026, 0.001)).toBe('0.003');
    expect(sliderReadout(0.00172, 0.0001)).toBe('0.0017');
    expect(sliderReadout(12, 1)).toBe('12.00');
    expect(sliderReadout(1 / 54, 1 / 240)).toBe('0.0185');
  });

  it('keeps two significant digits of a value too small for those decimals', () => {
    expect(sliderReadout(0.00012, 0.01)).toBe('0.00012');
    expect(sliderReadout(0)).toBe('0.00');
  });
});
