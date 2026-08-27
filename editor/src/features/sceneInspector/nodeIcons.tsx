import { Glyph as S } from './iconBase';

/**
 * Glyphs for node types — the Add catalog's non-geometry entries and the scene tree's per-row icons.
 * They follow `currentColor` like the rest of the editor's chrome, so a tree row's icon tints when the row
 * is selected, dimmed for a dormant node, or greyed inside a template instance.
 * One module for both surfaces: the palette and the tree name the same concepts.
 */

// --- Structure -------------------------------------------------------------------------------------

/** Empty node: a pivot. Axis ticks around a centre point, which is all a bare Node really is. */
export const EmptyIcon = () => (
  <S><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /></S>
);
/** Trigger volume: a dashed box — a region that is present but not solid. */
export const TriggerIcon = () => (
  <S><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3.4 2.6" /><circle cx="12" cy="12" r="2.6" /></S>
);
/** Model: a shaded isometric box, distinct from the Cube primitive by its filled top face. */
export const ModelIcon = () => (
  <S><path d="M12 3 20.5 7.5 12 12 3.5 7.5 12 3Z" fill="currentColor" fillOpacity="0.35" /><path d="M3.5 7.5v9L12 21v-9" /><path d="M20.5 7.5v9L12 21" /></S>
);

// --- Cameras ---------------------------------------------------------------------------------------

/** Camera body with the lens cone pointing right. */
export const CameraIcon = () => (
  <S><rect x="2.5" y="7" width="12" height="10" rx="2" /><path d="M14.5 11.5 21.5 7.5v9l-7-4z" /></S>
);
/** A camera on a boom arm, pivoting about its target. */
export const CameraRigIcon = () => (
  <S><rect x="11" y="4" width="10.5" height="8" rx="1.8" /><path d="M11 8H6.5a3 3 0 0 0-3 3v3" /><circle cx="3.5" cy="18" r="2.8" /></S>
);

// --- Lights ----------------------------------------------------------------------------------------

/** Generic light: a lamp with rays. Used for the tree row, where the light's subtype is not yet known. */
export const LightIcon = () => (
  <S><circle cx="12" cy="12" r="4" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" /></S>
);
/** Directional light: parallel rays from a distant source. */
export const DirectionalLightIcon = () => (
  <S><circle cx="8.5" cy="8.5" r="3.5" /><path d="M8.5 2.5v2M8.5 12.5v2M2.5 8.5h2M12.5 8.5h2" /><path d="M13 17.5 20.5 10M9 21l7.5-7.5" opacity="0.7" /></S>
);
/** Point light: a bulb radiating in every direction. */
export const PointLightIcon = () => (
  <S><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" /><path d="M12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9" opacity="0.8" /></S>
);
/** Spotlight: a cone of light from a housing. */
export const SpotlightIcon = () => (
  <S><path d="M9 3.5h6l5 17H4z" /><path d="M9 3.5h6" /><path d="M7.2 12h9.6" opacity="0.6" /></S>
);
/** Light probe: concentric rings, matching the viewport billboard it rasterises to. */
export const LightProbeIcon = () => (
  <S><circle cx="12" cy="12" r="3.2" /><circle cx="12" cy="12" r="8" strokeDasharray="2.6 3" /></S>
);

// --- Sprites / 2D ----------------------------------------------------------------------------------

/** Static sprite: a framed image. */
export const SpriteIcon = () => (
  <S><rect x="3.5" y="4.5" width="17" height="15" rx="1.8" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="M4.5 17l4.5-4.5 3.5 3.5 3-2.5 4.5 3.5" /></S>
);
/** Animated sprite: the same frame with the stack behind it. */
export const AnimatedSpriteIcon = () => (
  <S><rect x="3" y="7" width="13.5" height="12" rx="1.6" /><path d="M7 4.5h11a2.5 2.5 0 0 1 2.5 2.5v9" opacity="0.6" /><path d="M4 16l3.8-3.8 2.9 2.9 2.4-2 3.4 2.7" /></S>
);
/** Tilemap: a grid with one cell filled — the same shape as the tileset asset icon and the mode button. */
export const TilemapIcon = () => (
  <S><rect x="3.5" y="3.5" width="17" height="17" rx="1.5" /><path d="M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17" /><rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" /></S>
);

// --- Environment -----------------------------------------------------------------------------------

/** Skybox: a cube unfolded to its horizon band — an environment that surrounds the scene. */
export const SkyboxIcon = () => (
  <S><rect x="3.5" y="3.5" width="17" height="17" rx="1.5" /><path d="M3.5 14h17" /><path d="M7 14l3.5-4 3 3.4 2-2.2L20.5 14" opacity="0.7" /><circle cx="8" cy="7.5" r="1.8" /></S>
);
/** Sky atmosphere: the sun low over a curved horizon, which is what the scattering model draws. */
export const SkyAtmosphereIcon = () => (
  <S><path d="M2.5 17.5a9.5 9.5 0 0 1 19 0" /><circle cx="12" cy="12.5" r="3" /><path d="M2.5 20.5h19" opacity="0.6" /></S>
);
/** Sky light: rays coming DOWN from a dome, which is what a sky light is. */
export const SkyLightIcon = () => (
  <S><path d="M3.5 8.5a8.5 8.5 0 0 1 17 0" /><path d="M6 12.5v3" /><path d="M12 12.5v5" /><path d="M18 12.5v3" /></S>
);
/** Volumetric clouds. */
export const CloudsIcon = () => (
  <S><path d="M7 18.5h10a4 4 0 0 0 .6-7.95 5.5 5.5 0 0 0-10.5-1.2A3.9 3.9 0 0 0 7 18.5Z" /></S>
);
/** Landscape: a hill and peak under a sun — matching the Landscape mode button. */
export const LandscapeIcon = () => (
  <S><path d="M3 19 9 8l4 6 2-3 6 8Z" /><circle cx="17" cy="6" r="2" /></S>
);

// --- Row controls ----------------------------------------------------------------------------------

export const VisibleIcon = () => (
  <S><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></S>
);
/** Hidden: the same eye, struck through. */
export const HiddenIcon = () => (
  <S><path d="M4 15.5a17 17 0 0 1-1.5-3.5S6 5.5 12 5.5a9 9 0 0 1 4 .95M20 8.6a16.6 16.6 0 0 1 1.5 3.4S18 18.5 12 18.5a9.3 9.3 0 0 1-2.6-.36" /><path d="M3.5 3.5l17 17" /></S>
);
