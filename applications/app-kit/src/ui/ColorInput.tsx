import React from 'react';
import { cn } from './cn';

export interface ColorInputProps {
  color: string | number | readonly string[] | undefined;
  onChange: (value: [number, number, number]) => void;
  className?: string;
}

/**
 * The swatch hex of a linear `[r, g, b]` colour (components 0..1, clamped; a glow above 1 shows as its full
 * colour). THE conversion every colour row uses: the numbers are the colour, with no gamma between them and
 * the swatch, so a picked swatch and typed numbers always agree.
 */
export function colorToHex(color: ArrayLike<number> | null | undefined): string {
  const c = (i: number) => {
    const v = Number(color?.[i])
    return Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 255).toString(16).padStart(2, '0')
  }
  return `#${c(0)}${c(1)}${c(2)}`
}

/** The linear `[r, g, b]` (0..1) of a swatch hex (`#rrggbb`); black for anything else. */
export function hexToColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '')
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

const hexToVec3 = hexToColor;

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
