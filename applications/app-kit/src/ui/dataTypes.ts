// Single source of truth for data-type color-coding used by the typed selectors and inputs.
// Colors are token-based CSS color strings so they track the palette.

export interface TypeMeta {
  label: string;
  color: string; // a css color, e.g. 'rgb(var(--primary))'
}

const c = (v: string) => `rgb(var(${v}))`;

/** GLSL uniform types + node-variable types → label & swatch color. */
export const TYPE_META: Record<string, TypeMeta> = {
  // scalars
  float:       { label: 'float',   color: c('--primary') },
  number:      { label: 'number',  color: c('--primary') },
  int:         { label: 'int',     color: c('--selected') },
  bool:        { label: 'bool',    color: c('--danger') },
  boolean:     { label: 'boolean', color: c('--danger') },
  string:      { label: 'string',  color: c('--warning') },
  // vectors
  vec2:        { label: 'vec2',    color: c('--success') },
  vec3:        { label: 'vec3',    color: c('--highlight') },
  vec4:        { label: 'vec4',    color: c('--axis-z') },
  // samplers
  sampler2D:   { label: 'Texture', color: c('--axis-y') },
  samplerCube: { label: 'Cubemap', color: c('--axis-x') },
};

export const typeMeta = (type: string): TypeMeta => TYPE_META[type] ?? { label: type, color: c('--muted') };
