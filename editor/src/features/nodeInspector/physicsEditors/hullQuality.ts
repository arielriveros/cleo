import type { HullQuality } from 'cleo';

/**
 * Convex-hull definition presets; the face budgets come from `HULL_BUDGETS` in the engine. Low is exactly
 * the mesh's bounding box; every level still encloses each mesh vertex, so lower is looser, never tighter.
 */
export const HULL_QUALITIES: { value: HullQuality; label: string; title: string }[] = [
  { value: 'low', label: 'Low', title: 'Bounding box (6 faces) — cheapest to simulate' },
  { value: 'medium', label: 'Medium', title: 'Up to 14 faces' },
  { value: 'high', label: 'High', title: 'Up to 26 faces' },
  { value: 'veryHigh', label: 'Very High', title: 'Up to 50 faces — tightest fit, most expensive' },
];
