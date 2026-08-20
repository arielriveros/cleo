/**
 * Inline SVG glyphs for the UI element catalog.
 *
 * Inline rather than twelve new PNG imports: `ModeSelector` already established SVG-as-currentColor as the
 * house style for new chrome, and these need to tint with the cell's text colour anyway.
 */

const S = { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** A screen with an anchored rect inside it. */
export const CanvasIcon = () => (
  <svg {...S}><rect x="2.5" y="4" width="19" height="16" rx="1.5" /><rect x="5.5" y="7" width="7" height="5" rx="1" opacity="0.6" /></svg>
);
/** A billboard on a post: UI standing in the world. */
export const WorldUIIcon = () => (
  <svg {...S}><rect x="4" y="3.5" width="16" height="10" rx="1.5" /><path d="M12 13.5v7M8.5 20.5h7" /></svg>
);
export const PanelIcon = () => (
  <svg {...S}><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" /></svg>
);
export const StackIcon = () => (
  <svg {...S}><rect x="4" y="4" width="16" height="4" rx="1" /><rect x="4" y="10" width="16" height="4" rx="1" /><rect x="4" y="16" width="16" height="4" rx="1" /></svg>
);
export const SpacerIcon = () => (
  <svg {...S}><path d="M4 5h16M4 19h16" /><path d="M12 8.5v7M9.5 11 12 8.5 14.5 11M9.5 13 12 15.5 14.5 13" /></svg>
);
export const TextIcon = () => (
  <svg {...S}><path d="M5 6.5h14M12 6.5v11M9 17.5h6" /></svg>
);
export const ImageIcon = () => (
  <svg {...S}><rect x="3.5" y="5" width="17" height="14" rx="1.5" /><circle cx="8.5" cy="10" r="1.4" /><path d="M4.5 17l4.5-4.5 3.5 3.5 3-2.5 4 3.5" /></svg>
);
export const ButtonIcon = () => (
  <svg {...S}><rect x="3" y="8" width="18" height="8" rx="4" /><path d="M13.5 14.5l2.5 4 1-2 2 .5-3-4" fill="currentColor" stroke="none" /></svg>
);
export const ProgressIcon = () => (
  <svg {...S}><rect x="3" y="9.5" width="18" height="5" rx="2.5" /><path d="M5.5 12h6.5" strokeWidth="3.4" /></svg>
);
export const SliderIcon = () => (
  <svg {...S}><path d="M3.5 12h17" /><circle cx="14" cy="12" r="3" fill="currentColor" stroke="none" /></svg>
);
export const ToggleIcon = () => (
  <svg {...S}><rect x="2.5" y="7.5" width="19" height="9" rx="4.5" /><circle cx="16.5" cy="12" r="2.6" fill="currentColor" stroke="none" /></svg>
);
export const TextInputIcon = () => (
  <svg {...S}><rect x="3" y="7" width="18" height="10" rx="1.5" /><path d="M6.5 10v4" /></svg>
);
