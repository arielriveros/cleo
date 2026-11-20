import { Glyph } from '@cleo/app-kit/ui'

// The pose list's glyphs (PoseLibrary). Inline currentColor SVG, sized by the container (see app-kit ui/icons):
// a `w-4 h-4` box draws one at 16px.

type IconProps = React.SVGProps<SVGSVGElement>

/** A pencil: edit this pose (its bones turn with the gizmo or the numbers). */
export const EditPoseIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M4 20l4-1 11-11-3-3L5 16l-1 4z' /><path d='M14 7l3 3' /></Glyph>
)

/** A branch: a variant of this pose (stored relative to it, so it follows every edit to it). */
export const VariantIcon = (props: IconProps) => (
  <Glyph {...props}><circle cx='6' cy='5' r='2' /><circle cx='6' cy='19' r='2' /><circle cx='18' cy='12' r='2' /><path d='M6 7v10M6 12h3a5 5 0 0 0 5-5V7' /><path d='M14 7h2' /></Glyph>
)

/** A broken link: make a variant a pose of its own. */
export const DetachIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 3 9' /><path d='M4 4l16 16' /></Glyph>
)

/** A frame round a figure: a new pose from the character as it stands now. */
export const CapturePoseIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3' /><circle cx='12' cy='9' r='2' /><path d='M12 11v4M9 13h6M10 18l2-3 2 3' /></Glyph>
)

/** A crosshair: put the blend space's probe on this pose's sample. */
export const GoToSampleIcon = (props: IconProps) => (
  <Glyph {...props}><circle cx='12' cy='12' r='7' /><path d='M12 2v4M12 18v4M2 12h4M18 12h4' /><circle cx='12' cy='12' r='1.5' /></Glyph>
)

/** A circle with a dot: show this pose on the character. */
export const ShowPoseIcon = (props: IconProps) => (
  <Glyph {...props}><circle cx='12' cy='12' r='8' /><circle cx='12' cy='12' r='3' /></Glyph>
)
