import React from 'react';

/**
 * The shared `<svg>` wrapper for the catalog / scene-tree glyph sets.
 * Sized by its container, not by itself: `width`/`height` are 100%, so the same glyph draws at 28px in the
 * Add palette and 16px in the scene tree. Props are forwarded, so an icon can override stroke or class.
 */
export const Glyph = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox='0 0 24 24' width='100%' height='100%' fill='none' stroke='currentColor'
    strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
);

export default Glyph;
