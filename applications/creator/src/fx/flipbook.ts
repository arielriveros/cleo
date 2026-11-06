// Packing rendered frames into the tileset flipbook FX Creator exports: one atlas image, tiles left to
// right then top to bottom, plus the metadata the engine reads it with -- a Tileset (graphics/tilemap/
// tileset.ts) for the atlas grid and the particle renderer's `flipbook` settings (particles/
// particleModules.ts), so the result drops straight into a particle system's Render module.

export interface AtlasLayout {
  columns: number;
  rows: number;
  /** The tile's width (its side, for the usual square tile). */
  tile: number;
  tileWidth: number;
  tileHeight: number;
  width: number;
  height: number;
}

/**
 * The grid that holds `frames` tiles in the squarest atlas: for square tiles the squarest grid, for tall
 * ones more columns (32 tall tiles pack 8 x 4), for wide ones more rows.
 */
export function atlasLayout(frames: number, tileWidth: number, tileHeight = tileWidth): AtlasLayout {
  const columns = Math.max(1, Math.ceil(Math.sqrt((frames * tileHeight) / tileWidth) - 1e-9));
  const rows = Math.max(1, Math.ceil(frames / columns));
  return { columns, rows, tile: tileWidth, tileWidth, tileHeight, width: columns * tileWidth, height: rows * tileHeight };
}

/** Top-left pixel of frame `i`. */
export function tileOrigin(layout: AtlasLayout, i: number): [number, number] {
  return [(i % layout.columns) * layout.tileWidth, Math.floor(i / layout.columns) * layout.tileHeight];
}

/** Copy one tile's pixels into its cell of the atlas. */
export function blitTile(atlas: Uint8Array, layout: AtlasLayout, i: number, tilePixels: ArrayLike<number>): void {
  const [x0, y0] = tileOrigin(layout, i);
  const w = layout.tileWidth, h = layout.tileHeight;
  for (let y = 0; y < h; y++) {
    const dst = ((y0 + y) * layout.width + x0) * 4;
    for (let k = 0; k < w * 4; k++) atlas[dst + k] = tilePixels[y * w * 4 + k];
  }
}

/**
 * Fade a straight-alpha tile's coverage to nothing over the outer `share` of its width and height
 * (smoothstep), in place: whatever reaches the frame's edge fades out instead of ending on a line.
 */
export function fadeEdges(tile: Uint8Array, width: number, height: number, share: number): Uint8Array {
  if (!(share > 0)) return tile;
  const ramp = (d: number, n: number) => {
    const t = Math.min(1, Math.max(0, (d + 0.5) / Math.max(1, share * n)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < height; y++) {
    const wy = ramp(Math.min(y, height - 1 - y), height);
    for (let x = 0; x < width; x++) {
      const w = wy * ramp(Math.min(x, width - 1 - x), width);
      if (w >= 1) continue;
      const k = (y * width + x) * 4 + 3;
      tile[k] = Math.round(tile[k] * w);
    }
  }
  return tile;
}

/**
 * Seamless looping: frames rendered past the end (`tail`, K of them) are cross-faded into the first K,
 * so frame N-1 flows into frame 0. Frame i < K becomes lerp(tail[i], head[i], (i + 1) / (K + 1)): almost
 * all tail at the start (which is what continues frame N-1), all head by frame K.
 *
 * The colour is blended premultiplied by the coverage, so a transparent pixel's undefined colour cannot
 * bleed into an opaque one. The coverage is the frames' own alpha, unless `cover` gives it: an atlas whose
 * alpha is something else -- the six-way negative map's is the emission, zero for plain smoke, which
 * blended as coverage wiped its light out of the first K frames -- takes the coverage of the frames in
 * `cover` (as rendered: not yet blended themselves) and blends its own alpha as a plain value.
 */
export function loopBlend(head: Uint8Array[], tail: Uint8Array[], cover?: { head: Uint8Array[]; tail: Uint8Array[] }): void {
  const K = Math.min(head.length, tail.length);
  for (let i = 0; i < K; i++) {
    const w = (i + 1) / (K + 1);
    const a = head[i], b = tail[i];
    const ca = cover ? cover.head[i] : a, cb = cover ? cover.tail[i] : b;
    for (let p = 0; p < a.length; p += 4) {
      const aa = ca[p + 3] / 255, ba = cb[p + 3] / 255;
      const alpha = ba + (aa - ba) * w;
      for (let c = 0; c < 3; c++) {
        const pre = (b[p + c] * ba) + ((a[p + c] * aa) - (b[p + c] * ba)) * w;
        a[p + c] = alpha > 1e-4 ? Math.round(Math.min(255, pre / alpha)) : 0;
      }
      a[p + 3] = cover ? Math.round(b[p + 3] + (a[p + 3] - b[p + 3]) * w) : Math.round(alpha * 255);
    }
  }
}

/**
 * `.tileset` asset JSON for the atlas, in the Editor's TilesetAsset shape (a superset of the engine's
 * TilesetConfig). `frames` is extra: how many cells actually hold a frame when the grid has spares.
 */
export function tilesetJson(layout: AtlasLayout, id: string, textureId: string, name: string, frames: number, overdrive = 1) {
  return {
    id,
    name,
    textureId,
    imageWidth: layout.width,
    imageHeight: layout.height,
    tileWidth: layout.tileWidth,
    tileHeight: layout.tileHeight,
    margin: 0,
    spacing: 0,
    columns: layout.columns,
    rows: layout.rows,
    // Above 1 lets fire cross the bloom threshold and glow; 1 leaves smoke as authored.
    overdrive,
    tiles: {},
    terrains: [],
    variantSets: [],
    textureIds: [textureId],
    frames,
  };
}

/** The particle Render module's `flipbook` block that plays this atlas. */
export function particleFlipbook(layout: AtlasLayout, frames: number, fps: number, loops: boolean) {
  return { columns: layout.columns, rows: layout.rows, frames, mode: loops ? 'fps' : 'life', fps, cycles: 1, randomStart: loops, blend: true };
}
