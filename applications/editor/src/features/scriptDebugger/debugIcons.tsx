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
// A bug: debugging, in the panel's cards.
export const BugIcon = () => (<S width='16' height='16'><path d='M9 8V6.5a3 3 0 0 1 6 0V8' /><rect x='7' y='8' width='10' height='12' rx='5' /><path d='M12 12v8M3.5 13H7M17 13h3.5M4.5 8.5 7.5 10M19.5 8.5 16.5 10M4.5 19l3-2M19.5 19l-3-2' /></S>);
// A breakpoint: the gutter's dot.
export const BreakpointIcon = () => (<S><circle cx='12' cy='12' r='5.5' fill='currentColor' stroke='none' /></S>);
// Breakpoints off: the dot struck through.
export const BreakpointsOffIcon = () => (<S><circle cx='12' cy='12' r='5.5' /><path d='M5 19 19 5' /></S>);
