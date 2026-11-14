import { BASE_CLASS } from '../../utils/scripts'
import type { BridgeHost } from './bridgeHost'

// The project's asset libraries by the kind names the tools use (applications/mcp/src/catalog.mjs
// ASSET_KINDS, which the editor suite checks against this list): what asset_list lists and what workspace
// openAsset opens.

export interface LibraryItem { id: string; name: string; note?: string }

type Engine = BridgeHost['engine']

export const LIBRARIES: Record<string, (e: Engine) => LibraryItem[]> = {
  template: e => e.templates.map(t => ({ id: t.id, name: t.name, note: t.variant ? 'variant' : undefined })),
  model: e => e.models.map(m => ({ id: m.id, name: m.name, note: m.rigId ? 'rigged' : undefined })),
  material: e => e.materials.map(m => ({ id: m.id, name: m.name, note: m.material?.type === 'basic' ? 'unlit' : m.material?.type })),
  terrainMaterial: e => e.terrainMaterials.map(m => ({ id: m.id, name: m.name })),
  script: e => e.scriptAssets.map(s => ({ id: s.id, name: s.name, note: s.kind === 'module' ? 'module' : `extends ${BASE_CLASS[s.baseType] ?? s.baseType}` })),
  animation: e => e.animations.map(a => ({ id: a.id, name: a.name })),
  animationField: e => e.animationFields.map(f => ({ id: f.id, name: f.name })),
  animController: e => e.animControllers.map(c => ({ id: c.id, name: c.name })),
  rig: e => e.rigs.map(r => ({ id: r.id, name: r.name })),
  aiBrain: e => e.aiBrains.map(b => ({ id: b.id, name: b.name, note: b.kind })),
  particleSystem: e => e.particleSystems.map(s => ({ id: s.id, name: s.name })),
  sequence: e => e.sequences.map(s => ({ id: s.id, name: s.name, note: `${s.sequence.duration.toFixed(1)} s` })),
  sound: e => e.soundSamples.map(s => ({ id: s.id, name: s.name })),
  texture: e => e.textures.map(t => ({ id: t.id, name: t.name })),
  tileset: e => e.tilesets.map(t => ({ id: t.id, name: t.name })),
}

/** Each kind's tab opener: the editor's own enter*Editor, focusing the tab when it is open already. */
export const OPENERS: Record<string, (e: Engine, id: string) => void> = {
  template: (e, id) => e.enterTemplateEditor(id),
  model: (e, id) => e.enterModelEditor(id),
  material: (e, id) => e.enterMaterialEditor(id),
  terrainMaterial: (e, id) => e.enterTerrainMaterialEditor(id),
  script: (e, id) => e.enterScriptEditor(id),
  animation: (e, id) => e.enterClipEditor(id),
  animationField: (e, id) => e.enterAnimationFieldEditor(id),
  animController: (e, id) => e.openAnimController(id),
  rig: (e, id) => e.enterRigEditor(id),
  aiBrain: (e, id) => e.enterAiBrainEditor(id),
  particleSystem: (e, id) => e.enterParticleSystemEditor(id),
  sequence: (e, id) => e.enterSequenceEditor(id),
  sound: (e, id) => e.enterSoundEditor(id),
  texture: (e, id) => e.enterTextureEditor(id),
  tileset: (e, id) => e.enterTilesetEditor(id),
}
