import type { HullQuality } from 'cleo';

/**
 * Convex-hull definition presets; the face budgets come from `HULL_BUDGETS` in the engine. Every
 * level fully encloses the mesh — a lower definition is a looser wrapper, never a tighter one.
 */
export const HULL_QUALITIES: { value: HullQuality; label: string; title: string }[] = [
  { value: 'low', label: 'Low', title: 'Up to 12 faces — loosest fit, cheapest to simulate' },
  { value: 'medium', label: 'Medium', title: 'Up to 24 faces' },
  { value: 'high', label: 'High', title: 'Up to 48 faces' },
  { value: 'veryHigh', label: 'Very High', title: 'Up to 96 faces — tightest fit, most expensive' },
];
