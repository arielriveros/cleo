import { base64ToBytes } from 'cleo'

// Publish-time compression of a landscape's bulk terrain data.
//
// A serialized Terrain carries two large base64 strings inside the scene JSON: the Uint16 height field
// (~44 KB at the default resolution, 260 KB at 513) and the raw RGBA splat map (~88 KB / 1 MB). Base64
// costs a further 33% on top, and both sit in the manifest STRING, so they are neither deduped nor
// compressed by anything downstream.
//
// DEFLATE rather than PNG, deliberately. The splat's four channels are the four paint layers' blend
// weights, so alpha is data, not transparency — and canvas 2D is premultiplied, which means encoding
// through a canvas destroys the RGB of every texel where layer 3's weight is zero (the common case).
// There is no canvas-based path that round-trips this losslessly. DEFLATE is the same algorithm PNG
// uses for its IDAT chunks, so the compression ratio is effectively identical, and it is byte-exact.
//
// Runs on the MAIN THREAD (CompressionStream is not available to the project worker's constrained
// context in the same way, and this sits alongside the other main-thread publish prep in
// buildMultiSceneGameData). The packer then moves the resulting byte arrays into game.bin.

/** Weight-map/height payloads below this many bytes are left as base64 — the framing isn't worth it. */
const MIN_COMPRESS_BYTES = 512

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Replace each landscape's base64 `heights`/`splat` with deflated byte arrays, in place.
 *
 * Best-effort: any failure leaves the base64 fields exactly as they were, so the publish degrades to
 * the previous behaviour rather than shipping a terrain with no shape. `Terrain.deserialize` reads
 * either form, and prefers the decoded one.
 */
export async function compressTerrainData(node: any): Promise<void> {
  if (!node || typeof node !== 'object') return

  const terrain = node.terrain
  if (terrain) {
    try {
      if (typeof terrain.heights === 'string') {
        const raw = base64ToBytes(terrain.heights)
        if (raw.byteLength >= MIN_COMPRESS_BYTES) {
          terrain.heightBytes = await deflate(raw)
          delete terrain.heights
        }
      }
      if (typeof terrain.splat === 'string') {
        const raw = base64ToBytes(terrain.splat)
        if (raw.byteLength >= MIN_COMPRESS_BYTES) {
          terrain.splatBytes = await deflate(raw)
          delete terrain.splat
        }
      }
    } catch (e) {
      // Leave whatever survived: a half-converted terrain still has one field in each pair.
      console.warn('[publish] terrain data compression failed, keeping base64', e)
    }
  }

  for (const child of node.children ?? []) await compressTerrainData(child)
}

/**
 * The same treatment for a tilemap's cell grids, in place.
 *
 * A chunk is 1024 Uint32 cells = 4 KB raw, 5.5 KB as base64, and a painted map has many of them — but the
 * data is extremely compressible (long runs of the same tile, and every cell's high byte is zero), so this
 * is where the ratio is best. Best-effort, exactly like the terrain path: a failure leaves the base64
 * intact and `TilemapLayer.parse` reads either form.
 */
export async function compressTilemapData(node: any): Promise<void> {
  if (!node || typeof node !== 'object') return

  const tilemap = node.tilemap
  if (tilemap) {
    for (const layer of tilemap.layers ?? []) {
      for (const chunk of layer?.chunks ?? []) {
        try {
          if (typeof chunk.data === 'string') {
            const raw = base64ToBytes(chunk.data)
            if (raw.byteLength >= MIN_COMPRESS_BYTES) {
              chunk.dataBytes = await deflate(raw)
              delete chunk.data
            }
          }
          if (typeof chunk.tint === 'string') {
            const raw = base64ToBytes(chunk.tint)
            if (raw.byteLength >= MIN_COMPRESS_BYTES) {
              chunk.tintBytes = await deflate(raw)
              delete chunk.tint
            }
          }
        } catch (e) {
          console.warn('[publish] tilemap data compression failed, keeping base64', e)
        }
      }
    }
  }

  for (const child of node.children ?? []) await compressTilemapData(child)
}
