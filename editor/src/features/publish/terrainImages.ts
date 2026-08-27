import { base64ToBytes } from 'cleo'

// Publish-time compression of a landscape's bulk terrain data: the Uint16 height field and the raw RGBA
// splat map, both base64 strings in the scene JSON that nothing downstream dedupes or compresses.
// DEFLATE, not PNG: the splat's alpha is a paint layer's blend weight, not transparency, and canvas 2D is
// premultiplied, so encoding through a canvas destroys the RGB wherever layer 3's weight is zero.
// Runs on the MAIN THREAD (CompressionStream); the packer moves the byte arrays into game.bin.

/** Weight-map/height payloads below this many bytes are left as base64 — the framing isn't worth it. */
const MIN_COMPRESS_BYTES = 512

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Replace each landscape's base64 `heights`/`splat` with deflated byte arrays, in place.
 * Best-effort: any failure leaves the base64 fields exactly as they were. `Terrain.deserialize` reads
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
 * Best-effort like the terrain path: a failure leaves the base64 intact and `TilemapLayer.parse` reads
 * either form.
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
