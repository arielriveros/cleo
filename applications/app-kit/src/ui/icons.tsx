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

/** An Erlenmeyer flask: experimental (a feature that works but may still change). */
export const FlaskIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3' /><path d='M7 15h10' /></Glyph>
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

/** A square: stop. */
export const StopIcon = (props: IconProps) => (
  <Glyph {...props}><rect x='6' y='6' width='12' height='12' rx='1.5' fill='currentColor' /></Glyph>
);

/** Two arrows chasing each other round: loop. */
export const LoopIcon = (props: IconProps) => (
  <Glyph {...props}>
    <path d='M4.5 11V9.5a3 3 0 0 1 3-3H18' /><path d='M15.5 4 18 6.5 15.5 9' />
    <path d='M19.5 13v1.5a3 3 0 0 1-3 3H6' /><path d='M8.5 20 6 17.5 8.5 15' />
  </Glyph>
);

/** A bar and a triangle pointing at it: back one frame. */
export const StepBackIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M7 5v14' strokeWidth='2.4' /><path d='M18 5.5v13l-9-6.5z' fill='currentColor' /></Glyph>
);

/** A triangle and a bar: forward one frame. */
export const StepForwardIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M17 5v14' strokeWidth='2.4' /><path d='M6 5.5v13l9-6.5z' fill='currentColor' /></Glyph>
);

/** A bar and two triangles pointing at it: to the start. */
export const ToStartIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M5 5v14' strokeWidth='2.4' /><path d='M13 6v12l-6.5-6zM20 6v12l-6.5-6z' fill='currentColor' /></Glyph>
);

/** Two triangles and a bar: to the end. */
export const ToEndIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M19 5v14' strokeWidth='2.4' /><path d='M4 6v12l6.5-6zM11 6v12l6.5-6z' fill='currentColor' /></Glyph>
);

/** A movie camera: look through the shot's camera. */
export const PilotIcon = (props: IconProps) => (
  <Glyph {...props}><rect x='3' y='7' width='12' height='10' rx='2' /><path d='M15 11l6-3.5v9L15 13z' /></Glyph>
);

/** A magnet: snap. */
export const SnapIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M6 4v8a6 6 0 0 0 12 0V4' /><path d='M6 8h4M14 8h4' /><path d='M10 4v8a2 2 0 0 0 4 0V4' /></Glyph>
);

/** A circling arrow: start over. */
export const RestartIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M4.5 12a7.5 7.5 0 1 0 2.2-5.3' /><path d='M4 3.5v4.5h4.5' /></Glyph>
);

/** An arrow down into a tray: an update to download, or downloading. */
export const UpdateIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M12 3.5v11' /><path d='M7.5 10 12 14.5 16.5 10' /><path d='M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3' /></Glyph>
);

/** An arrow up out of a circle's gap: restart into the new version. */
export const RestartUpdateIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M19.5 12a7.5 7.5 0 1 1-2.2-5.3' /><path d='M20 3.5v4.5h-4.5' /><path d='M12 15.5v-7' /><path d='M9 11.5l3-3 3 3' /></Glyph>
);

/** Two chain links: linked to an item of a library rather than owned. */
export const LinkIcon = (props: IconProps) => (
  <Glyph {...props}>
    <path d='M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7' />
    <path d='M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.7-1.7' />
  </Glyph>
);

/** A strip of film: render a movie. */
export const FilmIcon = (props: IconProps) => (
  <Glyph {...props}>
    <rect x='3.5' y='5' width='17' height='14' rx='1.5' />
    <path d='M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4' />
  </Glyph>
);

/** An open book: the documentation. */
export const BookIcon = (props: IconProps) => (
  <Glyph {...props}>
    <path d='M12 6.5C10.3 5 7.8 4.5 4 4.5v13c3.8 0 6.3.5 8 2 1.7-1.5 4.2-2 8-2v-13c-3.8 0-6.3.5-8 2Z' />
    <path d='M12 6.5v13' />
  </Glyph>
);

/** A pointer with a question mark beside it: What's This? (click something to read about it). */
export const WhatsThisIcon = (props: IconProps) => (
  <Glyph {...props}>
    <path d='M4 3.5l5.5 15 2-6 6-2z' />
    <path d='M15.5 3.8a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.1-2.5 3.6' />
    <path d='M18 11.2h.01' strokeWidth='2.4' />
  </Glyph>
);

/** A chevron pointing left: back. */
export const ChevronLeftIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M15 5l-7 7 7 7' /></Glyph>
);

/** A chevron pointing right: forward. */
export const ChevronRightIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M9 5l7 7-7 7' /></Glyph>
);

/** A window with a side column: show or hide a sidebar. */
export const SidebarIcon = (props: IconProps) => (
  <Glyph {...props}><rect x='3' y='4.5' width='18' height='15' rx='1.5' /><path d='M9 4.5v15' /></Glyph>
);

/** A house: the start page. */
export const HomeIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M4 11 12 4l8 7' /><path d='M6 9.5V20h4.5v-5.5h3V20H18V9.5' /></Glyph>
);

/** A cross: close. */
export const CloseIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M6 6l12 12M18 6 6 18' /></Glyph>
);

/** Two overlapping sheets: copy to the clipboard. */
export const CopyIcon = (props: IconProps) => (
  <Glyph {...props}><rect x='8.5' y='8.5' width='11' height='11' rx='1.5' /><path d='M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5' /></Glyph>
);

/** A magnifying glass: search. */
export const SearchIcon = (props: IconProps) => (
  <Glyph {...props}><circle cx='10.5' cy='10.5' r='6' /><path d='M15 15l5 5' /></Glyph>
);

/** A framed landscape: a picture (the docs viewer shows its caption in its place). */
export const ImageIcon = (props: IconProps) => (
  <Glyph {...props}><rect x='3.5' y='4.5' width='17' height='15' rx='1.5' /><circle cx='9' cy='9.5' r='1.6' /><path d='M4 17.5l5-5 4 4 2.5-2.5 4.5 4.5' /></Glyph>
);

/** A hash sign: the link to a heading. */
export const HashIcon = (props: IconProps) => (
  <Glyph {...props}><path d='M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16' /></Glyph>
);
