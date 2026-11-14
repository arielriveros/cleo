// The debugger's transport glyphs, in the top bar's idiom (topbarIcons.tsx): 24 viewBox, stroke =
// currentColor, so each takes the colour of its button.
import React from 'react';

const S = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
);

// Continue: a bar and a play mark — run on from here.
export const ContinueIcon = () => (<S><path d='M6 5v14' /><path d='M10 5.5v13l9-6.5Z' fill='currentColor' /></S>);
// Pause: two bars.
export const PauseIcon = () => (<S><path d='M8 5v14M16 5v14' strokeWidth='2.6' /></S>);
// Step over: an arc over a dot — run the line, calls and all.
export const StepOverIcon = () => (<S><path d='M4 13a8 8 0 0 1 15-3.5' /><path d='M19.5 4.5v5h-5' /><circle cx='12' cy='18' r='1.8' fill='currentColor' /></S>);
// Step into: an arrow down to a dot — into the call on this line.
export const StepIntoIcon = () => (<S><path d='M12 3v10' /><path d='M8 9.5l4 4 4-4' /><circle cx='12' cy='19' r='1.8' fill='currentColor' /></S>);
// Step out: an arrow up from a dot — finish this function.
export const StepOutIcon = () => (<S><path d='M12 14V4' /><path d='M8 7.5l4-4 4 4' /><circle cx='12' cy='19' r='1.8' fill='currentColor' /></S>);
// A breakpoint: the gutter's dot.
export const BreakpointIcon = () => (<S><circle cx='12' cy='12' r='5.5' fill='currentColor' stroke='none' /></S>);
// Breakpoints off: the dot struck through.
export const BreakpointsOffIcon = () => (<S><circle cx='12' cy='12' r='5.5' /><path d='M5 19 19 5' /></S>);
