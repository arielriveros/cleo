import React from 'react';
import { cn } from './cn';

export interface ColorInputProps {
  color: string | number | readonly string[] | undefined;
  onChange: (value: [number, number, number]) => void;
  className?: string;
}

const hexToVec3 = (color: string): [number, number, number] => {
  const parts = color.match(/[A-Za-z0-9]{2}/g)!.map((v) => parseInt(v, 16) / 255);
  return [parts[0], parts[1], parts[2]];
};

/**
 * Color swatch that reports a normalized `[r, g, b]` (0..1) triple.
 */
export function ColorInput({ color, onChange, className }: ColorInputProps) {
  return (
    <input
      type='color'
      className={cn('h-8 w-10 p-0 border border-border rounded bg-control cursor-pointer', className)}
      value={color}
      onChange={(e) => onChange(hexToVec3(e.target.value))}
    />
  );
}

export default ColorInput;
