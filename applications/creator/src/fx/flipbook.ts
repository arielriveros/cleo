// Packing rendered frames into the tileset flipbook FX Creator exports: one atlas image, tiles left to
// right then top to bottom, plus the metadata the engine reads it with -- a Tileset (graphics/tilemap/
// tileset.ts) for the atlas grid and the particle renderer's `flipbook` settings (particles/
// particleModules.ts), so the result drops straight into a particle system's Render module.

export interface AtlasLayout {
  columns: number;
  rows: number;
  tile: number;
  width: number;
  height: number;
}

/** The squarest grid that holds `frames` tiles. */
export function atlasLayout(frames: number, tile: number): AtlasLayout {
  const columns = Math.max(1, Math.ceil(Math.sqrt(frames)));
  const rows = Math.max(1, Math.ceil(frames / columns));
  return { columns, rows, tile, width: columns * tile, height: rows * tile };
}

/** Top-left pixel of frame `i`. */
export function tileOrigin(layout: AtlasLayout, i: number): [number, number] {
  return [(i % layout.columns) * layout.tile, Math.floor(i / layout.columns) * layout.tile];
}

/** Copy one tile's pixels into its cell of the atlas. */
export function blitTile(atlas: Uint8Array, layout: AtlasLayout, i: number, tilePixels: ArrayLike<number>): void {
  const [x0, y0] = tileOrigin(layout, i);
  const t = layout.tile;
  for (let y = 0; y < t; y++) {
    const dst = ((y0 + y) * layout.width + x0) * 4;
    for (let k = 0; k < t * 4; k++) atlas[dst + k] = tilePixels[y * t * 4 + k];
  }
}

/**
 * Seamless looping: frames rendered past the end (`tail`, K of them) are cross-faded into the first K,
 * so frame N-1 flows into frame 0. Frame i < K becomes lerp(tail[i], head[i], (i + 1) / (K + 1)): almost
 * all tail at the start (which is what continues frame N-1), all head by frame K.
 */
export function loopBlend(head: Uint8Array[], tail: Uint8Array[]): void {
  const K = Math.min(head.length, tail.length);
  for (let i = 0; i < K; i++) {
    const w = (i + 1) / (K + 1);
    const a = head[i], b = tail[i];
    // Blend premultiplied so a transparent pixel's undefined colour cannot bleed into an opaque one.
    for (let p = 0; p < a.length; p += 4) {
      const aa = a[p + 3] / 255, ba = b[p + 3] / 255;
      const alpha = ba + (aa - ba) * w;
      for (let c = 0; c < 3; c++) {
        const pre = (b[p + c] * ba) + ((a[p + c] * aa) - (b[p + c] * ba)) * w;
        a[p + c] = alpha > 1e-4 ? Math.round(Math.min(255, pre / alpha)) : 0;
      }
      a[p + 3] = Math.round(alpha * 255);
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
    tileWidth: layout.tile,
    tileHeight: layout.tile,
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
