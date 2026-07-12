import { VectorInput } from './ui/VectorInput';

interface AxisInputProps {
  step: number;
  min?: number;
  max?: number;
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
  /** Lock all three axes to a common ratio (uniform scaling). */
  uniform?: boolean;
}

/**
 * XYZ numeric triad. Thin wrapper over the generalized `VectorInput` (colored draggable axis labels,
 * clamped drag, click-to-type) that preserves the original `[x, y, z]` tuple API.
 */
export default function AxisInput(props: AxisInputProps) {
  return (
    <VectorInput
      value={props.value}
      onChange={(v) => props.onChange([v[0], v[1], v[2]])}
      labels={['X', 'Y', 'Z']}
      step={props.step}
      min={props.min}
      max={props.max}
      uniform={props.uniform}
    />
  );
}
