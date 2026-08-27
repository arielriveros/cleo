// Typography tokens — the single place the inspector's label / value / hint type is defined.
// The sizes, family and weights live in index.css (--text-ui, --font-ui, --weight-ui); the .type-*
// classes bind them to a role, and these constants add the role's color.

/** Row labels ("Mass", "Position", "Damping") — muted, so values and controls are what read first. */
export const labelClass = 'type-label text-muted';

/** Values and control text — full brightness at the same size as the label. */
export const valueClass = 'type-value';

/** Captions / helper text beneath a control. */
export const hintClass = 'type-hint text-dim';

/** Small uppercase sub-section title inside a section body ("Shapes"). */
export const sectionTitleClass = 'type-section uppercase tracking-wide text-dim';

/** Collapsable section header ("Rigid Body", "Transform"). */
export const headerClass = 'type-header tracking-wide';
