import type { HullQuality } from 'cleo';

/**
 * Convex-hull definition presets; the face budgets come from `HULL_BUDGETS` in the engine. Low is
 * exactly the mesh's bounding box; each level up carves volume off it but always still encloses
 * every mesh vertex — a lower definition is a looser wrapper, never a tighter one.
 */
export const HULL_QUALITIES: { value: HullQuality; label: string; title: string }[] = [
  { value: 'low', label: 'Low', title: 'Bounding box (6 faces) — cheapest to simulate' },
  { value: 'medium', label: 'Medium', title: 'Up to 14 faces' },
  { value: 'high', label: 'High', title: 'Up to 26 faces' },
  { value: 'veryHigh', label: 'Very High', title: 'Up to 50 faces — tightest fit, most expensive' },
];
