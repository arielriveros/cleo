// Inline SVG glyphs for the top menu bar, same idiom as sectionIcons / ModeSelector: 24 viewBox,
// stroke = currentColor, so every icon takes the color of the button it sits in.
import React from 'react';

const S = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
);

// Floppy disk — save to local storage.
export const SaveIcon = () => (<S><path d='M4 4h11l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z' /><path d='M8 4v5h7' /><rect x='8' y='14' width='8' height='7' /></S>);
// Arrow down into a tray — bring a file in.
export const ImportIcon = () => (<S><path d='M12 3v10' /><path d='M8 9.5l4 4 4-4' /><path d='M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3' /></S>);
// Arrow up out of a tray — send a file out.
export const ExportIcon = () => (<S><path d='M12 14V4' /><path d='M8 7.5l4-4 4 4' /><path d='M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3' /></S>);
// Rocket — ship a build.
export const PublishIcon = () => (<S><path d='M13.5 3.5c3 0 6 2 7 7-5 1-7 4-7 7-1.5-1-3-2-4.5-3.5S6 11 5 9.5c3 0 6-2 7-6Z' /><circle cx='14.5' cy='9.5' r='1.6' /><path d='M7 17c-1 1-1.5 2.5-1.5 4 1.5 0 3-.5 4-1.5' /></S>);
export const ChevronDownIcon = () => (<S width='12' height='12'><path d='M6 9l6 6 6-6' /></S>);
// Save-state feedback: spinner (animated by the caller), check, alert.
export const SpinnerIcon = () => (<S className='animate-spin'><path d='M21 12a9 9 0 1 1-6.22-8.56' /></S>);
export const CheckIcon = () => (<S><path d='M5 13l4 4L19 7' /></S>);
export const AlertIcon = () => (<S><path d='M12 3l9 16H3Z' /><path d='M12 10v4' /><path d='M12 17h.01' /></S>);
// Panel grid — restore the default dock layout.
export const LayoutIcon = () => (<S><rect x='3' y='4' width='18' height='16' rx='1.5' /><path d='M9 4v16M9 12h12' /></S>);
// Stacked folders — the project browser. Deliberately a folder rather than a document: a project is the
// container everything else lives in.
export const ProjectsIcon = () => (<S><path d='M3 8V6a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v1' /><path d='M2.5 10h17l-1.6 8.2a1 1 0 0 1-1 .8H5.1a1 1 0 0 1-1-.8Z' /></S>);

// Playback: filled marks (fill = currentColor) so they read as solid controls at 25px, unlike the
// stroke-only chrome around them.
const P = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox='0 0 24 24' width='13' height='13' fill='currentColor' stroke='none' {...props} />
);
export const PlayGlyph = () => (<P><path d='M7 4.5v15l13-7.5Z' /></P>);
export const PauseGlyph = () => (<P><rect x='6' y='4.5' width='4.5' height='15' rx='1' /><rect x='13.5' y='4.5' width='4.5' height='15' rx='1' /></P>);
export const StopGlyph = () => (<P><rect x='5.5' y='5.5' width='13' height='13' rx='1.5' /></P>);
