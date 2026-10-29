import { Glyph as S } from './iconBase';

/**
 * Glyphs for the Primitive and Complex geometry catalogs.
 * Every shape is drawn rather than imported: `AddItem.icon` is a component, so a new geometry costs no
 * binary asset and the glyph tints with its cell's text colour.
 * Solids are a silhouette plus the visible half of the near-side ellipse; the structural shapes use the
 * same loose isometric so both categories read as one family.
 */

// ---------------------------------------------------------------------------------------------------
// Primitive geometries
// ---------------------------------------------------------------------------------------------------

/** Isometric box: a top face plus the two visible side faces. */
export const CubeIcon = () => (
  <S><path d="M12 3 20.5 7.5 12 12 3.5 7.5 12 3Z" /><path d="M3.5 7.5v9L12 21v-9" /><path d="M20.5 7.5v9L12 21" /></S>
);
/** Circle with an equator ellipse, so it reads as a sphere rather than a disc. */
export const SphereIcon = () => (
  <S><circle cx="12" cy="12" r="8.5" /><ellipse cx="12" cy="12" rx="8.5" ry="3.4" /></S>
);
/** Straight walls closed by a full ellipse on top and the near half of one below. */
export const CylinderIcon = () => (
  <S><ellipse cx="12" cy="6.5" rx="7" ry="3" /><path d="M5 6.5v11M19 6.5v11" /><path d="M5 17.5a7 3 0 0 0 14 0" /></S>
);
/** Rounded tube: straight walls with a full cap ellipse on top and a hemisphere below. */
export const CapsuleIcon = () => (
  <S><path d="M7.5 8.5a4.5 4.5 0 0 1 9 0v7a4.5 4.5 0 0 1-9 0z" /><path d="M7.5 8.5a4.5 2.2 0 0 0 9 0" /></S>
);
/** Triangle silhouette closed by the base ellipse. */
export const ConeIcon = () => (
  <S><path d="M12 3.5 19 17.5" /><path d="M12 3.5 5 17.5" /><ellipse cx="12" cy="17.5" rx="7" ry="3" /></S>
);
/** A ring in perspective. The hole is half the outer width; a smaller inner ellipse reads as an eye. */
export const TorusIcon = () => (
  <S><ellipse cx="12" cy="12" rx="9.5" ry="6" /><ellipse cx="12" cy="12" rx="4.8" ry="2.8" /></S>
);
/** Square base in perspective with the front edges rising to the apex. */
export const PyramidIcon = () => (
  <S><path d="M12 3.5 21 17.5 12 20.5 3 17.5z" /><path d="M12 3.5 12 20.5" opacity="0.55" /></S>
);
/** A flat rectangle with its triangulation shown, which also tells it apart from the UI Panel glyph. */
export const QuadIcon = () => (
  <S><rect x="4.5" y="4.5" width="15" height="15" rx="1" /><path d="M4.5 19.5 19.5 4.5" opacity="0.5" /></S>
);
export const CircleIcon = () => (
  <S><circle cx="12" cy="12" r="8" /></S>
);
export const TriangleIcon = () => (
  <S><path d="M12 4.5 20 18.5H4z" /></S>
);

// ---------------------------------------------------------------------------------------------------
// Complex geometries
// ---------------------------------------------------------------------------------------------------

/** Wedge seen from the side, with the depth edge behind it. */
export const RampIcon = () => (
  <S><path d="M3.5 18.5 18 18.5 18 6.5Z" /><path d="M18 6.5 20.5 8.5 20.5 20.5 6 20.5" opacity="0.55" /></S>
);
/** The stepped profile, the shape the factory actually extrudes. */
export const StairsIcon = () => (
  <S><path d="M3.5 20.5V17h4.5v-3.5h4.5V10h4.5V6.5h3.5" /><path d="M3.5 20.5h17" opacity="0.55" /></S>
);
/** Treads fanning out around a centre post. */
export const SpiralStairsIcon = () => (
  <S><path d="M12 3.5v17" opacity="0.55" /><path d="M12 6h7M12 10h6.5M12 14H5.5M12 18H5" /><ellipse cx="12" cy="20.5" rx="7" ry="2" opacity="0.55" /></S>
);
/** Two piers carrying a semicircular vault. */
export const ArchIcon = () => (
  <S><path d="M4 20.5v-7a8 8 0 0 1 16 0v7" /><path d="M8 20.5v-7a4 4 0 0 1 8 0v7" /></S>
);
/** Pipe: an annular mouth on top of straight walls. */
export const TubeIcon = () => (
  <S><ellipse cx="12" cy="7" rx="7.5" ry="3.2" /><ellipse cx="12" cy="7" rx="3.6" ry="1.5" /><path d="M4.5 7v10M19.5 7v10" /><path d="M4.5 17a7.5 3.2 0 0 0 15 0" /></S>
);
/** Open-top shell seen from just above the rim: outer rim, inner rim a wall-thickness inside it, and the
 *  walls dropping away. Without the inner rim this is a cube. */
export const HollowBoxIcon = () => (
  <S><path d="M12 2.5 21 7 12 11.5 3 7Z" /><path d="M12 5 17 7.5 12 10 7 7.5Z" opacity="0.5" /><path d="M3 7v9l9 4.5 9-4.5V7" /></S>
);
/** Corner piece: a square base rising to one corner. */
export const CornerRampIcon = () => (
  <S><path d="M3.5 18.5 20.5 18.5 20.5 5.5Z" /><path d="M20.5 5.5 20.5 18.5" opacity="0.55" /><path d="M3.5 18.5 20.5 5.5" opacity="0.55" /></S>
);
