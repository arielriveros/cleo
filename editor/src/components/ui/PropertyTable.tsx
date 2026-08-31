import React from 'react';
import { cn } from './cn';
import { labelClass, valueClass } from './typography';
import { hintAffordance } from './Field';

export interface PropertyTableProps {
  /** Column widths, e.g. `['25%', '75%']` or `[25, 75]`. Defaults to a 40/60 split. */
  columns?: (string | number)[];
  head?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/** The label/value table scaffold shared by the property inspectors. */
export function PropertyTable({ columns = ['40%', '60%'], head, children, className }: PropertyTableProps) {
  return (
    <table className={cn('w-full border-collapse', className)}>
      <colgroup>
        {columns.map((w, i) => (
          <col key={i} span={1} style={{ width: typeof w === 'number' ? `${w}%` : w }} />
        ))}
      </colgroup>
      {head}
      <tbody>{children}</tbody>
    </table>
  );
}

export interface PropertyRowProps {
  label?: React.ReactNode;
  children?: React.ReactNode;
  divider?: boolean;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  /** Native tooltip on the label, for explanation that would otherwise be a paragraph under the row. */
  hint?: string;
}

/** A two-cell inspector row (label + value). Use inside `PropertyTable`. */
export function PropertyRow({
  label,
  children,
  divider = false,
  className,
  labelClassName,
  valueClassName,
  hint,
}: PropertyRowProps) {
  return (
    <tr className={cn(divider && 'border-b border-border', className)}>
      <td className={cn(labelClass, 'py-1 pr-2', hintAffordance(hint), labelClassName)} title={hint}>{label}</td>
      <td className={cn(valueClass, 'py-1', valueClassName)}>{children}</td>
    </tr>
  );
}

export default PropertyTable;
