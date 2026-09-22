import { useSyncExternalStore } from 'react'
import type { SculptTool, FalloffCurve, BrushShape } from 'cleo'

// The landscape brush's settings: which tool, and how it lands. Lives outside React, like toastStore, so
// the viewport brush (a non-rendering component with its own pointer loop), the tools panel and the
// floating toolbar all read ONE copy, and the pointer loop can read it without re-rendering anything.
//
// PERSISTED per browser: an artist who likes a soft 20 m brush should not rebuild it every session. Only
// the choices are stored — never which layer or landscape is active, which belong to a scene.
//
// The snapshot is immutable and replaced only on a real change: `useSyncExternalStore` compares by
// reference, so a fresh object per read would render forever.

export type LandscapeMode = 'sculpt' | 'paint' | 'foliage'
/** Paint toward the layer's target opacity, erase it, or erase EVERY layer back to the base. */
export type PaintTool = 'paint' | 'erase' | 'clearToBase'
export type FlattenMode = 'both' | 'raise' | 'lower'
/** Authoring view: off, the active paint layer's weight, or every surface in its own colour. */
export type WeightView = 'off' | 'layer' | 'all'

export interface LandscapeBrushSettings {
  mode: LandscapeMode
  sculptTool: SculptTool
  paintTool: PaintTool
  /** World units. */
  radius: number
  /** 0 hard .. 1 fully feathered; see `curveWeight` for what it means per curve. */
  falloff: number
  curve: FalloffCurve
  shape: BrushShape
  /** Degrees, for a square or stamp brush. */
  rotation: number
  /** Strength per tool, so switching Raise -> Smooth -> Raise does not lose the Raise setting. */
  strengths: Record<string, number>
  /** Keep applying while the mouse is held still, not only while it moves. */
  continuous: boolean
  /** 0..1, the opacity painting moves a layer toward. */
  targetOpacity: number
  flattenMode: FlattenMode
  /** Set Height's target, terrain-local metres. */
  setHeight: number
  noiseScale: number
  noiseSeed: number
  terraceStep: number
  terraceSharpness: number
  talusDegrees: number
  erosionIterations: number
  /** The foliage brush erases instead of scattering. */
  foliageErase: boolean
  weightView: WeightView
  /**
   * The paint layer strokes go into, by its stable id. NOT persisted: a layer belongs to a scene, and
   * the panel falls back to the topmost layer whenever this names none that exists.
   */
  paintLayerId: string | null
}

/** Strength slider bounds and meaning per tool. */
export interface StrengthSpec { min: number; max: number; step: number; label: string; hint: string; initial: number }

const RATE: StrengthSpec = { min: 0.5, max: 50, step: 0.5, label: 'Strength', hint: 'Metres per second at the brush centre', initial: 8 }
const BLEND: StrengthSpec = { min: 0.05, max: 1, step: 0.05, label: 'Strength', hint: 'How far each dab moves toward the result (1 = all the way)', initial: 0.4 }

/** What the strength slider means for each tool. */
export function strengthSpec(key: string): StrengthSpec {
  switch (key) {
    case 'raise': case 'lower': case 'stamp': return RATE
    case 'noise': return { ...RATE, hint: 'Metres of noise per second at the brush centre', initial: 3 }
    case 'smooth': case 'flatten': case 'setHeight': case 'terrace': return BLEND
    case 'ramp': return { ...BLEND, hint: 'How fully the ground is laid onto the ramp (1 = exactly)', initial: 1 }
    case 'erode': return { ...BLEND, hint: 'How much material slides per pass', initial: 0.5 }
    case 'hydro': return { ...BLEND, hint: 'How much rain falls per dab', initial: 0.5 }
    case 'paint': case 'erase': case 'clearToBase': return { min: 0.05, max: 1, step: 0.05, label: 'Flow', hint: 'How far each dab moves the mask toward its target', initial: 0.35 }
    default: return { min: 0.1, max: 10, step: 0.1, label: 'Strength', hint: '', initial: 1 }
  }
}

export const DEFAULT_BRUSH: LandscapeBrushSettings = {
  mode: 'sculpt',
  sculptTool: 'raise',
  paintTool: 'paint',
  radius: 10,
  falloff: 0.5,
  curve: 'soft',
  shape: 'circle',
  rotation: 0,
  strengths: {},
  continuous: true,
  targetOpacity: 1,
  flattenMode: 'both',
  setHeight: 0,
  noiseScale: 12,
  noiseSeed: 0,
  terraceStep: 4,
  terraceSharpness: 0.7,
  talusDegrees: 35,
  erosionIterations: 4,
  foliageErase: false,
  weightView: 'off',
  paintLayerId: null,
}

const STORAGE_KEY = 'cleo_landscape_brush_v1'

function load(): LandscapeBrushSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BRUSH }
    const saved = JSON.parse(raw)
    // Field by field over the defaults, so a settings blob from an older build picks up new fields.
    return { ...DEFAULT_BRUSH, ...saved, strengths: { ...(saved?.strengths ?? {}) }, weightView: 'off', paintLayerId: null }
  } catch {
    return { ...DEFAULT_BRUSH }
  }
}

let state: LandscapeBrushSettings = typeof localStorage === 'undefined' ? { ...DEFAULT_BRUSH } : load()
const listeners = new Set<() => void>()
let saveTimer: ReturnType<typeof setTimeout> | null = null

function persist(): void {
  if (typeof localStorage === 'undefined') return
  if (saveTimer) clearTimeout(saveTimer)
  // Debounced: a slider drag writes dozens of times a second.
  saveTimer = setTimeout(() => {
    saveTimer = null
    // The weight view is an authoring overlay, not a preference — it never survives a reload.
    const { paintLayerId: _scene, ...prefs } = state
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prefs, weightView: 'off' })) } catch { /* quota */ }
  }, 300)
}

/** The current settings. Stable until the next change. */
export function getBrush(): LandscapeBrushSettings { return state }

/** Merge a change in and notify. A no-op patch notifies nobody. */
export function setBrush(patch: Partial<LandscapeBrushSettings>): void {
  let changed = false
  for (const k of Object.keys(patch) as (keyof LandscapeBrushSettings)[])
    if (patch[k] !== state[k]) { changed = true; break }
  if (!changed) return
  state = { ...state, ...patch }
  persist()
  for (const l of listeners) l()
}

/** The key the active tool's strength is filed under. */
export function activeToolKey(b: LandscapeBrushSettings = state): string {
  return b.mode === 'sculpt' ? b.sculptTool : b.mode === 'paint' ? b.paintTool : 'foliage'
}

/** The active tool's strength (its remembered value, or the tool's default). */
export function activeStrength(b: LandscapeBrushSettings = state): number {
  const key = activeToolKey(b)
  return b.strengths[key] ?? strengthSpec(key).initial
}

/** Set the ACTIVE tool's strength, clamped to its range. */
export function setActiveStrength(value: number): void {
  const key = activeToolKey()
  const spec = strengthSpec(key)
  setBrush({ strengths: { ...state.strengths, [key]: Math.min(spec.max, Math.max(spec.min, value)) } })
}

export function subscribeBrush(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** React binding: re-renders on every change. */
export function useLandscapeBrush(): LandscapeBrushSettings {
  return useSyncExternalStore(subscribeBrush, getBrush, getBrush)
}

/** For tests: back to the defaults, without touching storage. */
export function resetBrushForTests(): void {
  state = { ...DEFAULT_BRUSH, strengths: {} }
  for (const l of listeners) l()
}
