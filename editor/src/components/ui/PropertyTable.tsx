import React from 'react';
import { cn } from './cn';

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
}

/** A two-cell inspector row (label + value). Use inside `PropertyTable`. */
export function PropertyRow({
  label,
  children,
  divider = true,
  className,
  labelClassName,
  valueClassName,
}: PropertyRowProps) {
  return (
    <tr className={cn(divider && 'border-b border-border', className)}>
      <td className={cn('py-1 pr-2', labelClassName)}>{label}</td>
      <td className={cn('py-1', valueClassName)}>{children}</td>
    </tr>
  );
}

export default PropertyTable;
