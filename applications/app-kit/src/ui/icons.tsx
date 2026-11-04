import React from 'react';

// Shared inline SVG glyphs, for both apps: a 24-unit viewBox and currentColor strokes, like the editor's
// sceneInspector/iconBase. Sized by the container (width and height are 100%), so a `w-4 h-4` box draws
// one at 16px. They stand where the UI used to show emoji, which render differently on every platform.

type IconProps = React.SVGProps<SVGSVGElement>;

/** The `<svg>` wrapper every glyph here draws into. Props are forwarded, so one can override stroke or class. */
export const Glyph = (props: IconProps) => (
  <svg viewBox='0 0 24 24' width='100%' height='100%' fill='none' stroke='currentColor'
    strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' aria-hidden {...props} />
);

const pip = (cx: number, cy: number) => <circle cx={cx} cy={cy} r='1.3' fill='currentColor' stroke='none' />;

/** A die: roll a new random seed. */
export const DiceIcon = (props: IconProps) => (
  <Glyph {...props}><rect x='4' y='4' width='16' height='16' rx='3' />{pip(8.5, 8.5)}{pip(12, 12)}{pip(15.5, 15.5)}</Glyph>
);

/** A lightning bolt: a trigger. */
export const BoltIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M13.5 2.5 5 13.5h6.5L10.5 21.5 19 10.5h-6.5z' /></Glyph>
);

/** A triangle: play. */
export const PlayIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M7 4.5v15l12-7.5z' fill='currentColor' /></Glyph>
);

/** Two bars: pause. */
export const PauseIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M8 5v14M16 5v14' strokeWidth='3' /></Glyph>
);

/** A circling arrow: start over. */
export const RestartIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M4.5 12a7.5 7.5 0 1 0 2.2-5.3' /><path d='M4 3.5v4.5h4.5' /></Glyph>
);

/** Two chain links: linked to an item of a library rather than owned. */
export const LinkIcon = (props: IconProps) => (
  <Glyph {...props}>
    <path d='M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7' />
    <path d='M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.7-1.7' />
  </Glyph>
);
