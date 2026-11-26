import { Glyph } from '@cleo/app-kit/ui'

// The node-graph canvas's own glyphs (MachineGraph): a reroute point's two ways and Tidy. Inline currentColor SVG,
// sized by the container (see app-kit ui/icons): a `w-4 h-4` box draws one at 16px.

type IconProps = React.SVGProps<SVGSVGElement>

/** -o- : the line passes through the point left to right. */
export const RerouteAcrossIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M2 12h6.5M15.5 12H22' /><circle cx='12' cy='12' r='3.5' /></Glyph>
)

/** | o | : the line passes through the point top to bottom. */
export const RerouteDownIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M12 2v6.5M12 15.5V22' /><circle cx='12' cy='12' r='3.5' /></Glyph>
)

/** Three columns of boxes joined left to right: lay the graph out in columns. */
export const TidyIcon = (props: IconProps) => (
  <Glyph {...props}>
    <rect x='2' y='9.5' width='5' height='5' rx='1' />
    <rect x='9.5' y='4' width='5' height='5' rx='1' /><rect x='9.5' y='15' width='5' height='5' rx='1' />
    <rect x='17' y='9.5' width='5' height='5' rx='1' />
    <path d='M7 12l2.5-5.5M7 12l2.5 5.5M14.5 6.5L17 12M14.5 17.5L17 12' />
  </Glyph>
)
