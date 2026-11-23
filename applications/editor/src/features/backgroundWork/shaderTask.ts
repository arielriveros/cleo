import type { ShaderActivity } from 'cleo'
import type { WorkRow } from './delayedTask'

// The "Compiling shaders" card's rows, from the engine's shader activity feed (src/graphics/shaderActivity.ts):
// one row per program being built, however many pipelines of it are (a material drawn opaque and in shadow
// builds several), and one row for the warm-up of the pipelines the project used last session. Pure, for the
// tests.

/** The material library as far as naming goes: an asset's name and its material's type. */
export interface NamedMaterial { name: string; material: { type?: unknown } | null | undefined }

/** Engine programs by a name a user knows them by. Anything else is spelled out from its program name. */
const PROGRAM_NAMES: Record<string, string> = {
  pbr: 'Lit materials',
  pbrTransparent: 'Transparent materials',
  geometryPBR: 'Lit materials (deferred)',
  cel: 'Cel-shaded materials',
  blinnPhong: 'Blinn-Phong materials',
  unlit: 'Unlit materials',
  water: 'Water',
  terrain: 'Landscape',
}

/** A custom material's program: its key is `custom…:<content hash>` (customShaders.ts). */
const isCustom = (program: string) => /^custom\w*:/.test(program)

/**
 * What a program's row is called: a custom material by its name in the library (the asset whose material has
 * this type), an engine program by what it draws.
 */
export function programLabel(program: string, builtFor: string | null, materials: readonly NamedMaterial[]): string {
  if (isCustom(program) || (builtFor && isCustom(builtFor))) {
    const type = isCustom(program) ? program : builtFor
    const asset = materials.find(m => m.material?.type === type)
    return asset ? asset.name : 'Custom material'
  }
  if (PROGRAM_NAMES[program]) return PROGRAM_NAMES[program]
  // camelCase to words, its first letter up: 'volumetricClouds' -> 'Volumetric clouds'.
  const words = program.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The card's rows now: the programs being built, then the warm-up. */
export function shaderRows(activity: ShaderActivity, materials: readonly NamedMaterial[], now: number): WorkRow[] {
  const byProgram = new Map<string, { label: string; count: number; started: number; linking: boolean }>()
  for (const b of activity.active) {
    const entry = byProgram.get(b.program)
    if (entry) { entry.count++; entry.started = Math.min(entry.started, b.started); continue }
    byProgram.set(b.program, { label: programLabel(b.program, b.builtFor, materials), count: 1, started: b.started, linking: b.kind === 'program' })
  }
  const rows: WorkRow[] = []
  for (const [program, e] of byProgram) {
    const seconds = Math.max(0, Math.floor((now - e.started) / 1000))
    const what = e.linking ? 'Linking' : e.count > 1 ? `Building ${e.count} pipelines` : 'Building'
    rows.push({ key: `program:${program}`, name: e.label, detail: seconds >= 1 ? `${what} · ${seconds} s` : what })
  }
  if (activity.warm && activity.warm.total > 0) {
    rows.push({
      key: 'warm',
      name: 'Shaders from the last session',
      detail: `${activity.warm.done} of ${activity.warm.total}`,
      progress: activity.warm.done / activity.warm.total,
    })
  }
  return rows
}
