import { Glyph } from '@cleo/app-kit/ui'

// The animator graph's group glyphs, and the state inspector's hold. Inline currentColor SVG, sized by the
// container (see app-kit ui/icons): a `w-4 h-4` box draws one at 16px.

type IconProps = React.SVGProps<SVGSVGElement>

/** Two stacked boxes: put states in a group. */
export const GroupIcon = (props: IconProps) => (
  <Glyph {...props}><rect x='3' y='8' width='13' height='11' rx='2' /><path d='M8 5h11a2 2 0 0 1 2 2v10' /></Glyph>
)

/** Two boxes apart: take a group apart, its states back on the graph. */
export const UngroupIcon = (props: IconProps) => (
  <Glyph {...props}><rect x='3' y='3' width='8' height='8' rx='1.5' /><rect x='13' y='13' width='8' height='8' rx='1.5' /><path d='M15 6h3a2 2 0 0 1 2 2v2M9 18H6a2 2 0 0 1-2-2v-2' strokeDasharray='2 2' /></Glyph>
)

/** A box with an arrow going in: open a group, or move a state into one. */
export const IntoGroupIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4' /><path d='M20 4l-8 8M12 7v5h5' /></Glyph>
)

/** A box with an arrow coming out: take a state out of its group. */
export const OutOfGroupIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4' /><path d='M12 12l8-8M15 4h5v5' /></Glyph>
)

/** A flag on a box: the state a transition into the group enters. */
export const EntryIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M6 21V4M6 4h11l-2.5 3.5L17 11H6' /></Glyph>
)

/** Feet planted under a bar: the state holds the character still (no steering; root motion alone moves it). */
export const HoldIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M4 20h16' /><path d='M8 16v-6a2 2 0 0 1 4 0v6M12 16v-8a2 2 0 0 1 4 0v8' /><path d='M5 5h14' strokeDasharray='2 2.5' /></Glyph>
)
