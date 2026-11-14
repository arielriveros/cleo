// The split viewport's glyphs (no words on its chrome: an icon and a tooltip each). Built on the shared
// `Glyph` (24-unit viewBox, currentColor, sized by its container), so they tint with the button they sit in.

import type React from 'react';
import { Glyph } from '@cleo/app-kit/ui';
import type { PaneLayout, PanePreset } from './paneState';

type Icon = () => React.ReactElement;

// --- Layouts: the screen and how it is divided -----------------------------------------------------

const screen = <rect x='3' y='5' width='18' height='14' rx='2' />;

export const LAYOUT_ICONS: Record<PaneLayout, Icon> = {
  single: () => <Glyph>{screen}</Glyph>,
  columns: () => <Glyph>{screen}<path d='M12 5v14' /></Glyph>,
  rows: () => <Glyph>{screen}<path d='M3 12h18' /></Glyph>,
  grid: () => <Glyph>{screen}<path d='M12 5v14M3 12h18' /></Glyph>,
};

// --- Cameras: an isometric cube with the face the view looks at filled ----------------------------
//
// The hexagon's corners and its centre, where the near corner (and, hidden, the far one) projects. Each of
// the six faces covers its own rhombus of the hexagon, so every view reads apart: the visible ones (top,
// front, right, the default panes) bounded by the solid inner "Y", the hidden ones (bottom, back, left) by
// the faint dashed one. Front faces the viewer lower right; the character's right is then lower left.

const T = '12 2.5', UR = '20.2 7.25', LR = '20.2 16.75', B = '12 21.5', LL = '3.8 16.75', UL = '3.8 7.25', C = '12 12';
const face = (...corners: string[]) => `M${corners.join('L')}Z`;

const FACES: Record<Exclude<PanePreset, 'perspective'>, { d: string; hidden: boolean }> = {
  top: { d: face(T, UR, C, UL), hidden: false },
  front: { d: face(C, UR, LR, B), hidden: false },
  right: { d: face(UL, C, B, LL), hidden: false },
  bottom: { d: face(C, LR, B, LL), hidden: true },
  back: { d: face(UL, T, C, LL), hidden: true },
  left: { d: face(T, UR, LR, C), hidden: true },
};

const cube = (preset: Exclude<PanePreset, 'perspective'>) => {
  const f = FACES[preset];
  return () => (
    <Glyph strokeWidth='1.6'>
      <path d={f.d} fill='currentColor' fillOpacity={f.hidden ? 0.6 : 0.9} stroke='none' />
      <path d={face(T, UR, LR, B, LL, UL)} />
      <path d={`M${C}L${UL}M${C}L${UR}M${C}L${B}`} />
      {f.hidden && <path d={`M${C}L${T}M${C}L${LL}M${C}L${LR}`} strokeOpacity='0.55' strokeDasharray='1.6 1.6' />}
    </Glyph>
  );
};

/** A free perspective camera: a wireframe cube whose far face is smaller than its near one. */
const PerspectiveIcon: Icon = () => (
  <Glyph strokeWidth='1.6'>
    <rect x='3.5' y='9' width='10.5' height='10.5' rx='0.5' />
    <path d='M11 4.5h7.5V12' strokeOpacity='0.6' />
    <path d='M3.5 9 11 4.5M14 9l4.5-4.5M14 19.5l4.5-7.5' />
    <path d='M3.5 19.5 11 12M11 12V4.5M11 12h7.5' strokeOpacity='0.4' strokeDasharray='1.5 1.5' />
  </Glyph>
);

export const PRESET_ICONS: Record<PanePreset, Icon> = {
  perspective: PerspectiveIcon,
  top: cube('top'),
  bottom: cube('bottom'),
  front: cube('front'),
  back: cube('back'),
  left: cube('left'),
  right: cube('right'),
};

// --- Pane toggles ----------------------------------------------------------------------------------

/** Realtime: a pulse, the pane redrawn live every frame. */
export const RealtimeIcon: Icon = () => (
  <Glyph><path d='M3 12h4l2.5-6 5 12 2.5-6H21' /></Glyph>
);

/** The culling view: a camera's view frustum, one box inside it and one, dashed, cut off outside it. */
export const CullingIcon: Icon = () => (
  <Glyph strokeWidth='1.6'>
    <path d='M2.5 12 15 4.5v15Z' />
    <rect x='7.5' y='10.5' width='3.5' height='3.5' fill='currentColor' fillOpacity='0.45' />
    <rect x='17' y='9.5' width='4.5' height='4.5' strokeDasharray='1.6 1.4' />
  </Glyph>
);

/** A glyph at the chrome's icon size (the gizmo and eye buttons draw theirs at 15 px). */
export function PaneGlyph({ icon: I }: { icon: Icon }) {
  return <span className='block h-[15px] w-[15px]'><I /></span>;
}
