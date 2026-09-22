import { useSyncExternalStore } from 'react'
import { decodeHeightmap, Loader } from 'cleo'
import type { StampAlpha } from 'cleo'

// The Stamp tool's brush image: a grayscale alpha the brush multiplies its weight by. One at a time,
// held for the session and not saved — a stamp is a tool setting, not scene content.

export interface Stamp { name: string; alpha: StampAlpha }

let current: Stamp | null = null
const listeners = new Set<() => void>()

export function getStamp(): Stamp | null { return current }

export function setStamp(stamp: Stamp | null): void {
  current = stamp
  for (const l of listeners) l()
}

export function useStamp(): Stamp | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    getStamp, getStamp)
}

/**
 * Decode a picked image file into a stamp. PNG and RAW go through the full-precision heightmap decoder
 * (a 16-bit stamp stays 16-bit); anything else the browser can decode goes through a canvas at 8 bits.
 */
export async function loadStampFile(file: File): Promise<Stamp> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.png') || lower.endsWith('.raw') || lower.endsWith('.r16')) {
    const img = await decodeHeightmap(bytes)
    return { name: file.name, alpha: { data: img.data, width: img.width, height: img.height } }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await Loader.ImageToArray(url)
    const data = new Float32Array(img.width * img.height)
    for (let i = 0; i < data.length; i++) data[i] = img.data[i * 4] / 255
    return { name: file.name, alpha: { data, width: img.width, height: img.height } }
  } finally {
    URL.revokeObjectURL(url)
  }
}
