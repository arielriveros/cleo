import { PropertyRow, PropertyTable } from '../ui';
import { GenericParamField, type GenericParamSpec } from './ParamField';

/**
 * A whole parameter set drawn from its schema: one labelled row per spec whose `when` holds. The same
 * bargain the particle editor's module cards make -- a generator that declares its parameters gets its
 * UI for free, with sliders, presets and seed variations working the same way everywhere.
 */
export interface ParamFormProps<P extends Record<string, unknown>> {
  schema: readonly GenericParamSpec[];
  values: P;
  /** Several keys at once; `coalesce` true while a slider is being dragged. */
  onChange: (patch: Partial<P>, coalesce?: boolean) => void;
  /** Column split between label and control. */
  columns?: [string, string];
}

export function ParamForm<P extends Record<string, unknown>>({ schema, values, onChange, columns = ['42%', '58%'] }: ParamFormProps<P>) {
  const visible = schema.filter(spec => !spec.when || spec.when(values));
  return (
    <PropertyTable columns={columns}>
      {visible.map((spec, i) => (
        <PropertyRow key={spec.key} label={spec.label} hint={spec.hint} divider={i < visible.length - 1}>
          <GenericParamField spec={spec} value={values[spec.key]}
                             onChange={(v, c) => onChange({ [spec.key]: v } as Partial<P>, c)} />
        </PropertyRow>
      ))}
    </PropertyTable>
  );
}

/** The value every spec starts at when a schema is instantiated without a preset. */
export function schemaDefaults(schema: readonly (GenericParamSpec & { default?: unknown })[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of schema) if (spec.default !== undefined) out[spec.key] = spec.default;
  return out;
}
