import React from 'react'
import type { SculptTool } from 'cleo'
import { Glyph as S } from '../sceneInspector/iconBase'
import type { LandscapeMode, PaintTool } from './landscapeBrushStore'

// The landscape tools as data: what each is called, what it does in one line, which key selects it and
// what it looks like. The tools panel, the floating toolbar and the hotkey handler all read this list, so
// a tool added here appears everywhere with the same name and the same key.

export interface LandscapeToolInfo<T extends string> {
  id: T
  label: string
  /** One line, for the tooltip. Says what a stroke DOES and what the modifiers do. */
  hint: string
  /** Digit that selects it within its mode, or undefined. */
  hotkey?: string
  icon: () => React.ReactElement
}

// --- icons ----------------------------------------------------------------------------------------

const RaiseIcon = () => <S><path d="M3 19h18" /><path d="M5 19c3-1 4-9 7-9s4 8 7 9" fill="currentColor" fillOpacity="0.25" /><path d="M12 3v5M9.5 5.5 12 3l2.5 2.5" /></S>
const LowerIcon = () => <S><path d="M3 9h18" /><path d="M5 9c3 1 4 9 7 9s4-8 7-9" fill="currentColor" fillOpacity="0.25" /><path d="M12 2v5M9.5 4.5 12 7l2.5-2.5" /></S>
const SmoothIcon = () => <S><path d="M3 16c2.5-5 5.5-5 9 0s6.5 5 9 0" /><path d="M3 11c2.5-2 5.5-2 9 0s6.5 2 9 0" strokeOpacity="0.5" /></S>
const FlattenIcon = () => <S><path d="M3 14h18" /><path d="M5 19c2-6 4-6 6-5M13 14c2 0 4 0 6 5" strokeOpacity="0.5" /><path d="M8 6h8M12 6v4" /></S>
const SetHeightIcon = () => <S><path d="M3 15h18" /><path d="M6 15V9h12v6" fill="currentColor" fillOpacity="0.25" /><path d="M20 4v5M18 6.5l2-2.5 2 2.5" /></S>
const RampIcon = () => <S><path d="M3 19h18" /><path d="M4 19 20 7v12z" fill="currentColor" fillOpacity="0.25" /><circle cx="5" cy="17.5" r="1.3" /><circle cx="19" cy="8.5" r="1.3" /></S>
const NoiseIcon = () => <S><path d="M3 15l2-3 2 4 2-6 2 5 2-3 2 4 2-5 2 3 2-2" /></S>
const TerraceIcon = () => <S><path d="M3 19h4v-4h4v-4h4V7h6" /><path d="M3 19 21 7" strokeOpacity="0.35" strokeDasharray="2 2" /></S>
const ErodeIcon = () => <S><path d="M3 19h18" /><path d="M4 19 9 8l3 4 2-2 6 9" fill="currentColor" fillOpacity="0.2" /><path d="M9 8l1 3M12 12l.5 2.5M14 10l1 3" strokeOpacity="0.6" /></S>
const HydroIcon = () => <S><path d="M12 3c3 4 5 6.5 5 9a5 5 0 0 1-10 0c0-2.5 2-5 5-9z" fill="currentColor" fillOpacity="0.25" /><path d="M4 21c3-2 5-2 8 0s5 2 8 0" /></S>
const StampIcon = () => <S><rect x="5" y="14" width="14" height="5" rx="1" /><path d="M9 14V9h6v5" /><path d="M8 9h8a2 2 0 0 0-2-4h-4a2 2 0 0 0-2 4z" fill="currentColor" fillOpacity="0.25" /></S>

const PaintIcon = () => <S><path d="M18 3l3 3-9 9-4 1 1-4z" fill="currentColor" fillOpacity="0.25" /><path d="M4 21c0-3 2-5 4-5" /></S>
const EraseIcon = () => <S><path d="M16 4l5 5-9 9H7l-3-3z" fill="currentColor" fillOpacity="0.25" /><path d="M11 9l5 5M7 21h13" /></S>
const ClearToBaseIcon = () => <S><rect x="3" y="14" width="18" height="6" rx="1" fill="currentColor" fillOpacity="0.25" /><path d="M6 11h12M8 7.5h8" strokeOpacity="0.55" /><path d="M12 3v8" /></S>

const ScatterIcon = () => <S><path d="M7 20v-5M7 15c-2 0-3-2-3-4 2 0 3 2 3 4zm0 0c2 0 3-2 3-4-2 0-3 2-3 4z" /><path d="M16 20v-7M16 13c-2.5 0-4-2.5-4-5 2.5 0 4 2.5 4 5zm0 0c2.5 0 4-2.5 4-5-2.5 0-4 2.5-4 5z" /><path d="M3 20h18" /></S>

export const SculptModeIcon = RaiseIcon
export const PaintModeIcon = PaintIcon
export const FoliageModeIcon = ScatterIcon

// --- catalog --------------------------------------------------------------------------------------

export const SCULPT_TOOLS: LandscapeToolInfo<SculptTool>[] = [
  { id: 'raise', label: 'Raise', hotkey: '1', icon: RaiseIcon, hint: 'Build ground up. Shift lowers, Ctrl smooths.' },
  { id: 'lower', label: 'Lower', hotkey: '2', icon: LowerIcon, hint: 'Dig ground down. Shift raises, Ctrl smooths.' },
  { id: 'smooth', label: 'Smooth', hotkey: '3', icon: SmoothIcon, hint: 'Average away bumps and sharp edges.' },
  { id: 'flatten', label: 'Flatten', hotkey: '4', icon: FlattenIcon, hint: 'Level to the height under the click. Ctrl+click picks the height first.' },
  { id: 'setHeight', label: 'Set Height', hotkey: '5', icon: SetHeightIcon, hint: 'Move ground toward an exact height.' },
  { id: 'ramp', label: 'Ramp', hotkey: '6', icon: RampIcon, hint: 'Drag from one point to another to lay a straight slope. Brush size is its half-width. Esc cancels.' },
  { id: 'noise', label: 'Noise', hotkey: '7', icon: NoiseIcon, hint: 'Break up the surface with fractal noise.' },
  { id: 'terrace', label: 'Terrace', hotkey: '8', icon: TerraceIcon, hint: 'Cut slopes into flat steps.' },
  { id: 'erode', label: 'Erode', hotkey: '9', icon: ErodeIcon, hint: 'Thermal erosion: over-steep ground slumps into scree.' },
  { id: 'hydro', label: 'Hydro', hotkey: '0', icon: HydroIcon, hint: 'Rain erosion: water carves gullies and deposits in hollows.' },
  { id: 'stamp', label: 'Stamp', icon: StampIcon, hint: 'Raise a shape from a grayscale image. Shift presses it in.' },
]

export const PAINT_TOOLS: LandscapeToolInfo<PaintTool>[] = [
  { id: 'paint', label: 'Paint', hotkey: '1', icon: PaintIcon, hint: 'Paint the active layer toward its target opacity. Shift erases.' },
  { id: 'erase', label: 'Erase', hotkey: '2', icon: EraseIcon, hint: 'Erase the active layer, revealing what is under it.' },
  { id: 'clearToBase', label: 'Clear to Base', hotkey: '3', icon: ClearToBaseIcon, hint: 'Erase EVERY paint layer, back to the base material and its rules.' },
]

export const MODES: { id: LandscapeMode; label: string; hotkey: string; icon: () => React.ReactElement; hint: string }[] = [
  { id: 'sculpt', label: 'Sculpt', hotkey: 'Q', icon: SculptModeIcon, hint: 'Shape the ground (Q)' },
  { id: 'paint', label: 'Paint', hotkey: 'W', icon: PaintModeIcon, hint: 'Paint layers over the base material (W)' },
  { id: 'foliage', label: 'Foliage', hotkey: 'E', icon: FoliageModeIcon, hint: 'Scatter or erase the foliage the materials define (E)' },
]

/** The tool a digit key selects in `mode`, or undefined. */
export function toolForHotkey(mode: LandscapeMode, key: string): string | undefined {
  const list: LandscapeToolInfo<string>[] = mode === 'sculpt' ? SCULPT_TOOLS : mode === 'paint' ? PAINT_TOOLS : []
  return list.find(t => t.hotkey === key)?.id
}

/** The tool a mode letter selects, or undefined. */
export function modeForHotkey(key: string): LandscapeMode | undefined {
  return MODES.find(m => m.hotkey.toLowerCase() === key.toLowerCase())?.id
}

/** Display info for any tool id. */
export function toolInfo(id: string): LandscapeToolInfo<string> | undefined {
  return (SCULPT_TOOLS as LandscapeToolInfo<string>[]).find(t => t.id === id)
    ?? (PAINT_TOOLS as LandscapeToolInfo<string>[]).find(t => t.id === id)
}
