// One small line glyph per World node type (NodeType.icon), in the app-kit's 24-unit Glyph frame: what
// the canvas cards, the add menu and the inspector show beside a node's name. No emoji.

import { Glyph } from '@cleo/app-kit/ui';

const PATHS: Record<string, string> = {
  noise: 'M3 15c2-4 3-4 4.5-1s2.5 3 4-2 3-5 4.5-1 2.5 3 5 0',
  continent: 'M4 14c2-5 5-7 8-5s4-1 6 1 1 5-2 6-6 1-8 2-5-1-4-4Z M3 19h18',
  ramp: 'M3 19 21 7v12Z',
  constant: 'M3 12h18 M3 19h18',
  mountain: 'M3 19 9.5 8l3 5 2.5-3.5L21 19Z',
  ridge: 'M3 17c3-6 5-8 9-8s6 2 9 8',
  valley: 'M3 7c3 6 5 8 9 8s6-2 9-8',
  river: 'M8 3c-3 4 5 6 2 10s4 5 2 8 M14 3c-2 3 4 5 2 9',
  road: 'M8 21 11 3 M16 21 13 3 M12 6v2 M12 11v2 M12 16v2',
  plateau: 'M3 19 7 10h10l4 9Z',
  terrace: 'M3 19h4v-4h4v-4h4V7h6',
  crater: 'M3 13c3 0 3-3 5-3s1 6 4 6 2-6 4-6 2 3 5 3 M3 19h18',
  coast: 'M3 6c4 0 5 3 4 6s2 5 6 5 M14 19c2-1 4-1 7 0 M12 15c2-1 4-1 6 0',
  combine: 'M5 7h6v10H5Z M13 7h6v10h-6Z M11 12h2',
  remap: 'M4 20c8 0 10-16 16-16 M4 4v16h16',
  heightMask: 'M3 18 9 9l4 5 3-3 5 7Z M3 12h18',
  slopeMask: 'M4 19 20 5 M4 19h16 M14 19a6 6 0 0 0-1.6-4.2',
  invert: 'M12 4a8 8 0 1 0 0 16Z M12 4a8 8 0 0 1 0 16',
  blur: 'M12 4c4 5 6 8 6 10a6 6 0 0 1-12 0c0-2 2-5 6-10Z',
  maskCombine: 'M9 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0 M15 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0',
  normalize: 'M4 4v16 M20 4v16 M4 18 10 9l3 4 7-9',
  filter: 'M3 19 8 9l2 4 2-6 2 5 2-3 5 10Z M8 9v10 M12 7v12 M16 10v9',
  thermal: 'M3 19 12 6l9 13Z M14 15l2 4 M10 17l-1 2',
  droplet: 'M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11Z',
  pipe: 'M3 8h6v8H3 M21 8h-6v8h6 M9 12h6',
  paint: 'M14 4l6 6-9 9H5v-6Z M12 6l6 6',
  output: 'M4 4h11l5 5v11H4Z M8 14l3 3 5-6',
};

export function NodeGlyph({ icon, className = 'w-3.5 h-3.5' }: { icon: string; className?: string }) {
  return (
    <span className={`inline-block shrink-0 ${className}`}>
      <Glyph><path d={PATHS[icon] ?? PATHS.constant} /></Glyph>
    </span>
  );
}

/** Port colours: heights and masks read apart at a glance. */
export const PORT_COLOR: Record<'height' | 'mask', string> = { height: '#6fa8dc', mask: '#e3b857' };
