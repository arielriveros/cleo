import React from 'react';

/**
 * The shared `<svg>` wrapper for the catalog / scene-tree glyph sets.
 *
 * **Sized by its container, not by itself.** The same glyph is drawn at 28px in the Add palette and at
 * 16px in the scene tree, so `width`/`height` are 100% and the wrapping element decides. The earlier
 * modules hard-coded 24px, which is why a `uiIcons` glyph overflowed its `w-4 h-4` box in the tree.
 *
 * Props are forwarded, so a single icon can still override the stroke width, opacity or class.
 */
export const Glyph = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox='0 0 24 24' width='100%' height='100%' fill='none' stroke='currentColor'
    strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
);

export default Glyph;
