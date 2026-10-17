import { useMemo, useState } from 'react'
import {
  TerrainMaterial, TerrainFoliageRule, Model, TextureManager, Logger,
  DEFAULT_FOLIAGE_DENSITY, FOLIAGE_DENSITY_UNIT, MAX_INSTANCES,
} from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import { buildFoliageRuleFromModelAsset } from '../../utils/foliageRules'
import { cryptoRandomId } from '../../utils/ids'
import { Button, FileButton, NumberInput, Select, TextInput, Toggle, cn, hintClass, labelClass } from '../../components/ui'
import { toast } from '../toasts/toastStore'

// The foliage a landscape material scatters, and the foliage it keeps off itself: shared by the
// landscape-material editor and the landscape's own Layers panel. Edits `material` IN PLACE and calls
// `onChange` — foliage rules are not part of the slot undo (their prototypes are rebuilt on change).

/** Area (units²) the density field is shown per: a 10 × 10 block. */
const DENSITY_BLOCK = 100
/** Terrain side length the density estimate is quoted against (matches the Landscape panel's default). */
const ESTIMATE_SIZE = 200

/** Instances a rule would place over a default-sized terrain — the sanity check on a per-m² number. */
const estimateFor = (r: TerrainFoliageRule): number =>
  Math.round((r.density ?? DEFAULT_FOLIAGE_DENSITY.mesh) * ESTIMATE_SIZE * ESTIMATE_SIZE)

export default function TerrainFoliageRules({ material, onChange }: { material: TerrainMaterial; onChange: () => void }) {
  const { terrainMaterials, models, materials, dropFoliageLayer, bakeFoliageImpostor } = useCleoEngine()
  const [newFoliageTex, setNewFoliageTex] = useState('')
  const [newFoliageModel, setNewFoliageModel] = useState('')
  // Index of the rule currently baking, so the button can report progress. The bake renders a scene and
  // reads it back, which is slow enough to need saying.
  const [bakingRule, setBakingRule] = useState(-1)
  const [, force] = useState(0)
  const mat = material
  const changed = () => { onChange(); force(x => x + 1) }
  const label = labelClass
  const num = 'w-16 px-1 py-0.5'

  // Union of foliage prototype names across the library and this material, for the exclude picker.
  const knownFoliageNames = useMemo(() => {
    const names = new Set<string>()
    for (const asset of terrainMaterials) {
      const inc = asset.material?.foliageInclude
      if (Array.isArray(inc)) for (const r of inc) if (r?.name) names.add(r.name)
    }
    for (const r of mat.foliageInclude) names.add(r.name)
    return Array.from(names)
  }, [terrainMaterials, mat])

  /**
   * Models offerable as a foliage prop: everything EXCEPT a generated LOD level.
   *
   * `generateLodLevel` strips `lods` and `cullDistance` from a level by design, so a rule built on one
   * has no chain to descend and no cull distance of its own — it draws that level's full geometry
   * out to the renderer's global distance. Picking one is always worse than picking the model it came
   * from, which reaches the same geometry through its LOD chain.
   */
  const foliageSourceModels = useMemo(() => models.filter(m => !m.lodSource), [models])

  const textureIds = useMemo(() =>
    Array.from(TextureManager.Instance.textures.keys()).filter(id => !id.startsWith('__editor__') && !id.startsWith('__debug__')),
    [mat])

  const addBillboard = () => {
    if (!newFoliageTex) { toast.warning('Pick a texture for the grass billboard.'); return }
    const name = `${newFoliageTex.slice(0, 10)}_${mat.foliageInclude.length}`
    // densityUnit must be stamped here: a rule pushed straight onto a live material never passes through
    // TerrainMaterial.parse, where an unmarked rule is treated as legacy and divided by 100.
    mat.foliageInclude.push({
      // A stable identity so the scattered layer follows this rule through a rename. A billboard has
      // no modelId to fall back on, so without this its only key would be the name.
      id: cryptoRandomId(),
      kind: 'billboard', name, textureId: newFoliageTex,
      density: DEFAULT_FOLIAGE_DENSITY.billboard, densityUnit: FOLIAGE_DENSITY_UNIT,
      minScale: 0.8, maxScale: 1.4,
    })
    changed()
  }
  const addModel = (files: File[]) => {
    if (files.length === 0) return
    Model.fromFile({ files }).then(models => {
      if (!models.length) return
      const rule: TerrainFoliageRule = {
        // An imported rule carries no modelId (nothing links it to a library asset), so this id is
        // the only thing that can keep its layer through a rename.
        id: cryptoRandomId(),
        kind: 'mesh', // rendering mode: real geometry, as opposed to 'billboard'
        name: `${models[0].name}_${mat.foliageInclude.length}`,
        model: models[0].model.serialize(),
        density: DEFAULT_FOLIAGE_DENSITY.mesh, densityUnit: FOLIAGE_DENSITY_UNIT,
        minScale: 0.8, maxScale: 1.4,
      }
      mat.foliageInclude.push(rule)
      changed()
    }).catch(err => console.error(err))
  }
  // Stays linked through rule.modelId, so saving the model asset refreshes the rule and live foliage.
  const addModelFromLibrary = () => {
    const asset = models.find(m => m.id === newFoliageModel)
    if (!asset) { toast.warning('Pick a model from the library.'); return }
    try {
      // `models` and `materials`, NEVER omitted: a LOD level is a REFERENCE to another model asset, so
      // without the library every level resolves to null and the rule is built with no `lods` at all.
      // The foliage layer then draws LOD0 at every distance, the readout below says "1 LOD level", and
      // the whole LOD feature looks broken when only this argument was missing.
      const rule = buildFoliageRuleFromModelAsset(asset, undefined, models, materials)
      rule.name = `${rule.name}_${mat.foliageInclude.length}`
      mat.foliageInclude.push(rule)
      changed()
    } catch (e) {
      Logger.warn(`${e}`, 'Editor')
    }
  }
  // Rebuilds from the linked model asset, keeping name/density/impostor.
  const resyncRule = (i: number) => {
    const r = mat.foliageInclude[i]
    const asset = r.modelId ? models.find(m => m.id === r.modelId) : undefined
    if (!asset) { Logger.warn('The source model asset no longer exists', 'Editor'); return }
    try {
      mat.foliageInclude[i] = buildFoliageRuleFromModelAsset(asset, r, models, materials)
      changed()
    } catch (e) {
      Logger.warn(`${e}`, 'Editor')
    }
  }
  /**
   * Drop a rule AND the runtime layer scattered from it.
   *
   * The layer is filed under `foliageRuleKey`, which is the rule's own id, so once the rule is gone
   * nothing can reach the layer again: `pruneFoliage` deliberately keeps any layer that still holds
   * instances, to protect hand-painted placement across a rename. Without this call the old layer kept
   * every instance and kept drawing — so replacing a prop's model rendered both of them at once.
   *
   * This does discard the painted placement. That is the point: the rule that decided where those
   * instances went no longer exists. Re-run Generate Foliage after adding the replacement.
   */
  const bakeImpostor = async (i: number) => {
    const rule = mat.foliageInclude[i]
    if (!rule?.modelId) { Logger.warn('This prototype has no library model to bake a card from', 'Editor'); return }
    setBakingRule(i)
    try {
      const id = await bakeFoliageImpostor(rule)
      if (!id) Logger.warn('Could not bake an impostor for this model', 'Editor')
      changed()
    } finally {
      setBakingRule(-1)
    }
  }

  const removeRule = (i: number) => {
    const rule = mat.foliageInclude[i]
    mat.foliageInclude.splice(i, 1)
    if (rule) dropFoliageLayer(rule)
    changed()
  }
  const patchRule = (i: number, patch: Partial<TerrainFoliageRule>) => { Object.assign(mat.foliageInclude[i], patch); changed() }
  const toggleExclude = (name: string, on: boolean) => {
    const set = new Set(mat.foliageExclude)
    if (on) set.add(name); else set.delete(name)
    mat.foliageExclude = Array.from(set)
    changed()
  }

  return (
    <>
        <Collapsable title='Foliage'>
          <div className='p-2 space-y-2' title='Foliage the landscape brush scatters where this material is painted.'>
            <div className='border border-control rounded p-2 space-y-1'>
              <div className={label}>Add grass billboard</div>
              <div className='flex gap-1'>
                <Select className={cn(num, 'flex-1')} value={newFoliageTex} onChange={e => setNewFoliageTex(e.target.value)}>
                  <option value=''>(texture)</option>
                  {textureIds.map(id => <option key={id} value={id}>{id.length > 16 ? id.slice(0, 15) + '…' : id}</option>)}
                </Select>
                <Button variant='success' size='sm' onClick={addBillboard}>+</Button>
              </div>
              <FileButton className='w-full py-1' accept='.obj,.gltf,.glb' multiple onFiles={addModel}>
                Add model prop (import)
              </FileButton>
              <div className={label}>Add model prop from library (uses its LOD levels)</div>
              <div className='flex gap-1'>
                <Select className={cn(num, 'flex-1')} value={newFoliageModel} onChange={e => setNewFoliageModel(e.target.value)}>
                  <option value=''>(model asset)</option>
                  {foliageSourceModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
                <Button variant='success' size='sm' onClick={addModelFromLibrary}>+</Button>
              </div>
            </div>

            {mat.foliageInclude.map((r, i) => (
              <div key={i} className='border border-control rounded p-2 space-y-1'>
                <div className='flex items-center gap-1'>
                  <TextInput className={cn(num, 'flex-1')} value={r.name} onChange={v => patchRule(i, { name: v })} title='Foliage name (referenced by exclude lists)' />
                  <span className='text-ui-xs text-muted'>{r.kind}</span>
                  <Button variant='remove' size='sm' className='px-1' onClick={() => removeRule(i)} title='Remove'>✕</Button>
                </div>
                <div className='flex items-center justify-between'>
                  {/* Shown per 10 × 10 block so sparse props read as whole numbers (5 trees, not 0.05); the rule
                      and the engine keep instances per unit², so this is display only — no migration. */}
                  <span className={label} title='Elements per 10 × 10 area (100 units²) — the same for the brush and for whole-terrain generation.'>Density / 10×10</span>
                  <NumberInput step={0.5} min={0} className={num} value={+((r.density ?? DEFAULT_FOLIAGE_DENSITY.mesh) * DENSITY_BLOCK).toFixed(3)}
                    onChange={v => patchRule(i, { density: Math.max(0, v) / DENSITY_BLOCK })} />
                </div>
                {/* Without this estimate a plausible-looking number silently clips at MAX_INSTANCES. */}
                <div className={cn('text-ui-xs', estimateFor(r) > MAX_INSTANCES ? 'text-danger-fg' : 'text-muted')}>
                  ≈ {estimateFor(r).toLocaleString()} instances on a {ESTIMATE_SIZE}×{ESTIMATE_SIZE} terrain
                  {estimateFor(r) > MAX_INSTANCES && ` — over the ${MAX_INSTANCES.toLocaleString()} ceiling`}
                </div>
                <div className='flex items-center justify-between'>
                  <span className={label}>Scale min/max</span>
                  <span className='flex gap-1'>
                    <NumberInput step={0.1} className={num} value={r.minScale ?? 0.8} onChange={v => patchRule(i, { minScale: v })} />
                    <NumberInput step={0.1} className={num} value={r.maxScale ?? 1.4} onChange={v => patchRule(i, { maxScale: v })} />
                  </span>
                </div>
                {/* Off by default: a layer casting shadows adds one instanced draw per cell PER CASCADE,
                    which is fine for a few hundred trees and expensive for a field of grass. */}
                <div className='flex items-center justify-between'>
                  <span className={label} title='Rasterize these instances into the shadow cascades. Costs one extra instanced draw per cell per cascade — cheap for trees, expensive for dense grass.'>Cast shadows</span>
                  <Toggle checked={!!r.castShadows} onChange={c => patchRule(i, { castShadows: c })} />
                </div>

                {r.kind === 'mesh' && <>
                  {/* LOD/cull come from the model asset (edited in the model editor) — shown, not edited. */}
                  {r.modelId && (
                    <div className='flex items-center justify-between'>
                      <span className='text-ui-xs text-muted'>
                        {1 + (r.lods?.length ?? 0)} LOD level{r.lods?.length ? 's' : ''}
                        {(r.cullDistance ?? 0) > 0 ? `, culls at ${r.cullDistance}` : ''} (from the model asset)
                      </span>
                      <Button variant='ghost' size='sm' className='px-1 text-ui-xs underline' title='Rebuild from the current model asset' onClick={() => resyncRule(i)}>re-sync</Button>
                    </div>
                  )}
                  {/* The card is what actually makes distant foliage cheap: a LOD level reduces triangles
                      linearly, this replaces them all with four. Baking is offered only for a rule with a
                      library model behind it — there is nothing to render otherwise. */}
                  {r.modelId && (
                    <div className='flex items-center justify-between'>
                      <span className={label} title='Pixel size of the baked card. Larger keeps distant leaves crisp and stable; costs memory per rule.'>Impostor size</span>
                      <Select className={num} value={String(r.impostorSize ?? 512)}
                        onChange={e => patchRule(i, { impostorSize: Number(e.target.value) })}>
                        <option value='512'>512</option>
                        <option value='1024'>1024</option>
                      </Select>
                    </div>
                  )}
                  {r.modelId && (
                    <Button
                      size='sm'
                      className='w-full text-ui-sm py-1'
                      disabled={bakingRule >= 0}
                      title='Render this model to a flat card and use it past the last LOD band. The single biggest win for a heavy prototype.'
                      onClick={() => void bakeImpostor(i)}>
                      {bakingRule === i ? 'Baking…' : (r.billboard ? 'Re-bake impostor' : 'Bake impostor')}
                    </Button>
                  )}
                  {/* Billboard impostor: the farthest LOD — past its distance instances draw as cross-quads. */}
                  <div className='flex items-center justify-between'>
                    <span className={label}>Billboard beyond</span>
                    <span className='flex gap-1'>
                      <Select
                        className={num}
                        value={r.billboard?.textureId ?? ''}
                        onChange={e => patchRule(i, { billboard: e.target.value ? { textureId: e.target.value, distance: r.billboard?.distance ?? 60 } : null })}>
                        <option value=''>(off)</option>
                        {textureIds.map(id => <option key={id} value={id}>{id.length > 16 ? id.slice(0, 15) + '…' : id}</option>)}
                      </Select>
                      {r.billboard && (
                        <NumberInput
                          min={0} className={num} title='Distance where the billboard takes over'
                          value={r.billboard.distance}
                          onChange={v => patchRule(i, { billboard: { textureId: r.billboard!.textureId, distance: Math.max(0, v) } })} />
                      )}
                    </span>
                  </div>

                  {/* Physics proxy. Only instances near the camera get a body (pooled + recycled), so this is
                      safe on a tree layer but should stay off for anything grass-like. */}
                  <div className='flex items-center justify-between'>
                    <span className={label} title='Static collider spawned for nearby instances. Off = walk straight through.'>Collision</span>
                    <Select
                      className={num}
                      value={r.collision?.shape ?? ''}
                      onChange={e => patchRule(i, {
                        collision: e.target.value
                          ? { shape: e.target.value as any, radius: r.collision?.radius ?? 0.4, height: r.collision?.height ?? 2 }
                          : null,
                      })}>
                      <option value=''>(none)</option>
                      <option value='cylinder'>Cylinder</option>
                      <option value='box'>Box</option>
                      <option value='sphere'>Sphere</option>
                    </Select>
                  </div>
                  {r.collision && (
                    <div className='flex items-center justify-between'>
                      <span className={label} title='Prototype units — each instance multiplies these by its own random scale.'>Radius / height</span>
                      <span className='flex gap-1'>
                        <NumberInput step={0.05} min={0} className={num} value={r.collision.radius ?? 0.4}
                          onChange={v => patchRule(i, { collision: { ...r.collision!, radius: Math.max(0, v) } })} />
                        <NumberInput step={0.1} min={0} className={num} value={r.collision.height ?? 2}
                          disabled={r.collision.shape === 'sphere'}
                          onChange={v => patchRule(i, { collision: { ...r.collision!, height: Math.max(0, v) } })} />
                      </span>
                    </div>
                  )}
                </>}
              </div>
            ))}
          </div>
        </Collapsable>

        <Collapsable title='Exclude foliage'>
          <div className='p-2 space-y-1' title='Foliage kept off this material even where a neighbouring material would place it.'>
            {knownFoliageNames.length === 0 && <p className={hintClass}>No foliage defined in the library yet.</p>}
            {knownFoliageNames.map(name => (
              <div key={name} className='flex items-center justify-between'>
                <span className={label}>{name}</span>
                <Toggle checked={mat.foliageExclude.includes(name)} onChange={c => toggleExclude(name, c)} />
              </div>
            ))}
          </div>
        </Collapsable>
    </>
  )
}
