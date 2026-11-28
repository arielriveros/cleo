import { Glyph } from '@cleo/app-kit/ui/icons'

// The Reactions tab's own glyphs (shared ones come from the app-kit): drawn in the 24-unit box every glyph uses,
// sized by their container. No emoji, a tooltip on every button that shows one.

type P = React.SVGProps<SVGSVGElement>

/** A crosshair: the mouse shoots. */
export const ShootIcon = (p: P) => (
  <Glyph {...p}><circle cx='12' cy='12' r='7' /><path d='M12 2v5M12 17v5M2 12h5M17 12h5' /></Glyph>
)

/** An open hand pushing: the mouse shoves. */
export const ShoveIcon = (p: P) => (
  <Glyph {...p}><path d='M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11.5V5a1.5 1.5 0 0 1 3 0v6.5M14 11.5V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6 7-2.8 0-4.3-1.3-5.7-3.6L3.6 14.3a1.4 1.4 0 0 1 2.3-1.6L8 15' /></Glyph>
)

/** A pointer arrow: the mouse does nothing to the body. */
export const NoToolIcon = (p: P) => (
  <Glyph {...p}><path d='M6 3l12 9-5.5 1.2L15 20l-2.6 1.1-2.6-6.4L6 18z' /></Glyph>
)

/** A foot catching on a block: trip. */
export const TripIcon = (p: P) => (
  <Glyph {...p}><path d='M4 20h16' /><rect x='13' y='15' width='5' height='5' rx='1' /><path d='M5 15c2-1 4-1 6 0l2 1' /><circle cx='9' cy='5' r='2' /><path d='M9 7l2 4-3 3' /></Glyph>
)

/** A figure with a layer drawn over it (dashed): an animation layer drawn over the body, not followed by it. */
export const OverlayIcon = (p: P) => (
  <Glyph {...p}><circle cx='9' cy='5' r='2' /><path d='M9 7v7M5 10h8M9 14l-3 6M9 14l3 6' /><path d='M14 5h6v14h-6' strokeDasharray='2 2' /></Glyph>
)

/** A body over an edge: fall. */
export const FallIcon = (p: P) => (
  <Glyph {...p}><path d='M3 9h8v12' /><circle cx='16' cy='6' r='2' /><path d='M16 8v5l3 3M16 13l-3 3M14 10l4 0' /></Glyph>
)

/** Out of a door at speed: bail. */
export const BailIcon = (p: P) => (
  <Glyph {...p}><rect x='3' y='8' width='10' height='8' rx='2' /><path d='M5 16v2M11 16v2' /><path d='M15 6l5-2M15 10h6M15 14l5 2' /></Glyph>
)

/** Stars round a head: knocked out. */
export const KnockOutIcon = (p: P) => (
  <Glyph {...p}><circle cx='12' cy='14' r='5' /><path d='M6 5l1 2M12 3v2M18 5l-1 2' /><path d='M10 14h.01M14 14h.01' /></Glyph>
)

/** A cross: kill. */
export const KillIcon = (p: P) => (
  <Glyph {...p}><path d='M12 3v18M7 8h10' /></Glyph>
)

/** A body rising from the ground: get up. */
export const GetUpIcon = (p: P) => (
  <Glyph {...p}><path d='M3 21h18' /><circle cx='12' cy='5' r='2' /><path d='M12 7v6l-3 4M12 13l3 4M9 10h6' /><path d='M18 14l2-2 2 2' /></Glyph>
)

/** A burst on a chest: a hit. */
export const HitIcon = (p: P) => (
  <Glyph {...p}><path d='M12 3l1.5 5 5-2-3 4.5 4.5 2.5-5 1 1 5-4-3.5-4 3.5 1-5-5-1 4.5-2.5-3-4.5 5 2z' /></Glyph>
)

/** A camera: capture the pose the body holds. */
export const CaptureIcon = (p: P) => (
  <Glyph {...p}><path d='M4 8h3l2-3h6l2 3h3v11H4z' /><circle cx='12' cy='13' r='3.5' /></Glyph>
)
