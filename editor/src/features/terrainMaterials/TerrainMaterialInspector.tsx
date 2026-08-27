import { useMemo, useState } from 'react'
import {
  Node, ModelNode, TerrainMaterial, TerrainFoliageRule, Model, TextureManager, Logger,
  DEFAULT_FOLIAGE_DENSITY, FOLIAGE_DENSITY_UNIT, MAX_INSTANCES,
} from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import MaterialEditor from '../nodeInspector/propertyEditors/MaterialEditor'
import TextureInspector from '../nodeInspector/propertyEditors/TextureInspector'
import { buildFoliageRuleFromModelAsset } from '../../utils/foliageRules'
import { Toggle } from '../../components/ui'

/** Terrain side length the density estimate is quoted against (matches the Landscape panel's default). */
const ESTIMATE_SIZE = 200

/** Instances a rule would place over a default-sized terrain — the sanity check on a per-m² number. */
const estimateFor = (r: TerrainFoliageRule): number =>
  Math.round((r.density ?? DEFAULT_FOLIAGE_DENSITY.mesh) * ESTIMATE_SIZE * ESTIMATE_SIZE)

// Right-sidebar inspector for the active terrain-material tab: the base surface, the terrain blend
// fields and the foliage include/exclude lists, edited on the preview sphere's TerrainMaterial in place.
export default function TerrainMaterialInspector(props: { node: Node | null }) {
  const { eventEmitter, editingTerrainMaterialName, setActiveTerrainMaterialName, terrainMaterials, models, refreshTerrainMaterialPreview } = useCleoEngine()
  const [, force] = useState(0)
  const [newFoliageTex, setNewFoliageTex] = useState('')
  const [newFoliageModel, setNewFoliageModel] = useState('')
  const rerender = () => force(x => x + 1)

  const node = props.node
  const tm = node && node.nodeType === 'model' ? ((node as ModelNode).model?.material as TerrainMaterial | undefined) : undefined
  const isTerrain = tm instanceof TerrainMaterial

  // Union of foliage prototype names across the library and this material, for the exclude picker.
  const knownFoliageNames = useMemo(() => {
    const names = new Set<string>()
    for (const asset of terrainMaterials) {
      const inc = asset.material?.foliageInclude
      if (Array.isArray(inc)) for (const r of inc) if (r?.name) names.add(r.name)
    }
    if (isTerrain) for (const r of tm!.foliageInclude) names.add(r.name)
    return Array.from(names)
  }, [terrainMaterials, isTerrain, tm])

  const textureIds = useMemo(() =>
    Array.from(TextureManager.Instance.textures.keys()).filter(id => !id.startsWith('__editor__') && !id.startsWith('__debug__')),
    [isTerrain])

  const changed = () => { refreshTerrainMaterialPreview(); eventEmitter.emit('SCENE_CHANGED'); rerender() }

  const label = 'text-xs text-slate-300'
  const num = 'w-16 bg-control text-white border border-border rounded px-1 py-[2px] text-xs'

  if (!isTerrain) {
    return <div className='p-3 text-xs text-gray-400'>Open a terrain material to edit it.</div>
  }
  const mat = tm!

  const addBillboard = () => {
    if (!newFoliageTex) { alert('Pick a texture for the grass billboard.'); return }
    const name = `${newFoliageTex.slice(0, 10)}_${mat.foliageInclude.length}`
    // densityUnit must be stamped here: a rule pushed straight onto a live material never passes through
    // TerrainMaterial.parse, where an unmarked rule is treated as legacy and divided by 100.
    mat.foliageInclude.push({
      kind: 'billboard', name, textureId: newFoliageTex,
      density: DEFAULT_FOLIAGE_DENSITY.billboard, densityUnit: FOLIAGE_DENSITY_UNIT,
      minScale: 0.8, maxScale: 1.4,
    })
    changed()
  }
  const addModel = (files: FileList | null) => {
    if (!files || files.length === 0) return
    Model.fromFile({ files: Array.from(files) }).then(models => {
      if (!models.length) return
      const rule: TerrainFoliageRule = {
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
    if (!asset) { alert('Pick a model from the library.'); return }
    try {
      const rule = buildFoliageRuleFromModelAsset(asset)
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
      mat.foliageInclude[i] = buildFoliageRuleFromModelAsset(asset, r)
      changed()
    } catch (e) {
      Logger.warn(`${e}`, 'Editor')
    }
  }
  const removeRule = (i: number) => { mat.foliageInclude.splice(i, 1); changed() }
  const patchRule = (i: number, patch: Partial<TerrainFoliageRule>) => { Object.assign(mat.foliageInclude[i], patch); changed() }
  const toggleExclude = (name: string, on: boolean) => {
    const set = new Set(mat.foliageExclude)
    if (on) set.add(name); else set.delete(name)
    mat.foliageExclude = Array.from(set)
    changed()
  }

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full h-full overflow-y-auto'>
      <div className='p-2 border-b border-success'>
        <label className='text-xs text-slate-300 block mb-1'>Terrain material name</label>
        <input
          className='bg-control text-white border border-success rounded px-2 py-1 w-full text-sm'
          value={editingTerrainMaterialName ?? ''}
          onChange={(e) => setActiveTerrainMaterialName(e.target.value)} />
      </div>

      {/* Base surface (Basic / Blinn-Phong / PBR) — mutates the TerrainMaterial in place. MaterialEditor's
          controls mutate before their change events bubble here, so `changed` re-derives the composite
          preview (setLayer) with the new values — without it only the blend fields would refresh the sphere. */}
      {node && node.nodeType === 'model' &&
        <div onChange={changed}>
          <MaterialEditor node={node as ModelNode} />
        </div>}

      <Collapsable title='Terrain blend'>
        <div className='p-2 space-y-2'>
          <div className='flex items-center justify-between'>
            <span className={label}>Tiling</span>
            <input type='number' className={num} value={mat.tiling} onChange={e => { mat.tiling = Number(e.target.value); changed() }} />
          </div>
          <div className='flex items-center justify-between'>
            <span className={label}>Auto height/slope</span>
            <Toggle checked={mat.auto} onChange={c => { mat.auto = c; changed() }} />
          </div>
          {mat.auto && <>
            <div className='flex items-center justify-between'>
              <span className={label}>Height min/max</span>
              <span className='flex gap-1'>
                <input type='number' className={num} value={mat.hRange[0]} onChange={e => { mat.hRange = [Number(e.target.value), mat.hRange[1]]; changed() }} />
                <input type='number' className={num} value={mat.hRange[1]} onChange={e => { mat.hRange = [mat.hRange[0], Number(e.target.value)]; changed() }} />
              </span>
            </div>
            <div className='flex items-center justify-between'>
              <span className={label}>Slope min/max</span>
              <span className='flex gap-1'>
                <input type='number' step={0.05} className={num} value={mat.sRange[0]} onChange={e => { mat.sRange = [Number(e.target.value), mat.sRange[1]]; changed() }} />
                <input type='number' step={0.05} className={num} value={mat.sRange[1]} onChange={e => { mat.sRange = [mat.sRange[0], Number(e.target.value)]; changed() }} />
              </span>
            </div>
          </>}

          {/* Displacement (height) map: drives parallax depth + height-aware blending. */}
          <div className='pt-1 border-t border-control space-y-1'>
            <span className={label}>Displacement (height) map</span>
            <div onChange={() => changed()}>
              <TextureInspector tex='displacementMap' material={mat} />
            </div>
            <div className='flex items-center justify-between'>
              <span className={label}>Parallax scale</span>
              <input type='number' step={0.01} min={0} className={num} value={mat.displacementScale} onChange={e => { mat.displacementScale = Number(e.target.value); changed() }} />
            </div>
            <div className='flex items-center justify-between'>
              <span className={label}>Height blend</span>
              <input type='number' step={0.5} min={0} className={num} value={mat.heightBlend} onChange={e => { mat.heightBlend = Number(e.target.value); changed() }} />
            </div>
          </div>
        </div>
      </Collapsable>

      <Collapsable title='Foliage'>
        <div className='p-2 space-y-2'>
          <p className='text-[11px] text-gray-400'>Foliage the landscape brush scatters where this material is painted.</p>
          <div className='border border-control rounded p-2 space-y-1'>
            <div className={label}>Add grass billboard</div>
            <div className='flex gap-1'>
              <select className={`${num} flex-1`} value={newFoliageTex} onChange={e => setNewFoliageTex(e.target.value)}>
                <option value=''>(texture)</option>
                {textureIds.map(id => <option key={id} value={id}>{id.length > 16 ? id.slice(0, 15) + '…' : id}</option>)}
              </select>
              <button className='bg-success hover:bg-success-hover rounded px-2 text-xs' onClick={addBillboard}>+</button>
            </div>
            <label className='block bg-control hover:bg-control-hover rounded px-2 py-1 text-xs text-center cursor-pointer'>
              Add model prop (import)
              <input type='file' className='hidden' accept='.obj,.gltf,.glb' multiple onChange={e => addModel(e.target.files)} />
            </label>
            <div className={label}>Add model prop from library (uses its LOD levels)</div>
            <div className='flex gap-1'>
              <select className={`${num} flex-1`} value={newFoliageModel} onChange={e => setNewFoliageModel(e.target.value)}>
                <option value=''>(model asset)</option>
                {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button className='bg-success hover:bg-success-hover rounded px-2 text-xs' onClick={addModelFromLibrary}>+</button>
            </div>
          </div>

          {mat.foliageInclude.map((r, i) => (
            <div key={i} className='border border-control rounded p-2 space-y-1'>
              <div className='flex items-center gap-1'>
                <input className={`${num} flex-1`} value={r.name} onChange={e => patchRule(i, { name: e.target.value })} title='Foliage name (referenced by exclude lists)' />
                <span className='text-[10px] text-gray-400'>{r.kind}</span>
                <button className='text-red-300 text-xs px-1' onClick={() => removeRule(i)} title='Remove'>✕</button>
              </div>
              <div className='flex items-center justify-between'>
                <span className={label} title='Instances per square metre — the same unit for the brush and for whole-terrain generation.'>Density /m²</span>
                <input type='number' step={0.01} min={0} className={num} value={r.density ?? DEFAULT_FOLIAGE_DENSITY.mesh} onChange={e => patchRule(i, { density: Math.max(0, Number(e.target.value)) })} />
              </div>
              {/* Without this estimate a plausible-looking number silently clips at MAX_INSTANCES. */}
              <div className={`text-[10px] ${estimateFor(r) > MAX_INSTANCES ? 'text-red-300' : 'text-gray-400'}`}>
                ≈ {estimateFor(r).toLocaleString()} instances on a {ESTIMATE_SIZE}×{ESTIMATE_SIZE} terrain
                {estimateFor(r) > MAX_INSTANCES && ` — over the ${MAX_INSTANCES.toLocaleString()} ceiling`}
              </div>
              <div className='flex items-center justify-between'>
                <span className={label}>Scale min/max</span>
                <span className='flex gap-1'>
                  <input type='number' step={0.1} className={num} value={r.minScale ?? 0.8} onChange={e => patchRule(i, { minScale: Number(e.target.value) })} />
                  <input type='number' step={0.1} className={num} value={r.maxScale ?? 1.4} onChange={e => patchRule(i, { maxScale: Number(e.target.value) })} />
                </span>
              </div>
              {/* Off by default: a layer casting shadows adds one instanced draw per cell PER CASCADE,
                  which is fine for a few hundred trees and expensive for a field of grass. */}
              <div className='flex items-center justify-between'>
                <span className={label} title='Rasterize these instances into the shadow cascades. Costs one extra instanced draw per cell per cascade — cheap for trees, expensive for dense grass.'>Cast shadows</span>
                <input type='checkbox' checked={!!r.castShadows} onChange={e => patchRule(i, { castShadows: e.target.checked })} />
              </div>

              {r.kind === 'mesh' && <>
                {/* LOD/cull come from the model asset (edited in the model editor) — shown, not edited. */}
                {r.modelId && (
                  <div className='flex items-center justify-between'>
                    <span className='text-[10px] text-gray-400'>
                      {1 + (r.lods?.length ?? 0)} LOD level{r.lods?.length ? 's' : ''}
                      {(r.cullDistance ?? 0) > 0 ? `, culls at ${r.cullDistance}` : ''} (from the model asset)
                    </span>
                    <button className='text-[10px] text-slate-300 underline px-1' title='Rebuild from the current model asset' onClick={() => resyncRule(i)}>re-sync</button>
                  </div>
                )}
                {/* Billboard impostor: the farthest LOD — past its distance instances draw as cross-quads. */}
                <div className='flex items-center justify-between'>
                  <span className={label}>Billboard beyond</span>
                  <span className='flex gap-1'>
                    <select
                      className={num}
                      value={r.billboard?.textureId ?? ''}
                      onChange={e => patchRule(i, { billboard: e.target.value ? { textureId: e.target.value, distance: r.billboard?.distance ?? 60 } : null })}>
                      <option value=''>(off)</option>
                      {textureIds.map(id => <option key={id} value={id}>{id.length > 16 ? id.slice(0, 15) + '…' : id}</option>)}
                    </select>
                    {r.billboard && (
                      <input
                        type='number' min={0} className={num} title='Distance where the billboard takes over'
                        value={r.billboard.distance}
                        onChange={e => patchRule(i, { billboard: { textureId: r.billboard!.textureId, distance: Math.max(0, Number(e.target.value)) } })} />
                    )}
                  </span>
                </div>

                {/* Physics proxy. Only instances near the camera get a body (pooled + recycled), so this is
                    safe on a tree layer but should stay off for anything grass-like. */}
                <div className='flex items-center justify-between'>
                  <span className={label} title='Static collider spawned for nearby instances. Off = walk straight through.'>Collision</span>
                  <select
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
                  </select>
                </div>
                {r.collision && (
                  <div className='flex items-center justify-between'>
                    <span className={label} title='Prototype units — each instance multiplies these by its own random scale.'>Radius / height</span>
                    <span className='flex gap-1'>
                      <input type='number' step={0.05} min={0} className={num} value={r.collision.radius ?? 0.4}
                        onChange={e => patchRule(i, { collision: { ...r.collision!, radius: Math.max(0, Number(e.target.value)) } })} />
                      <input type='number' step={0.1} min={0} className={num} value={r.collision.height ?? 2}
                        disabled={r.collision.shape === 'sphere'}
                        onChange={e => patchRule(i, { collision: { ...r.collision!, height: Math.max(0, Number(e.target.value)) } })} />
                    </span>
                  </div>
                )}
              </>}
            </div>
          ))}
        </div>
      </Collapsable>

      <Collapsable title='Exclude foliage'>
        <div className='p-2 space-y-1'>
          <p className='text-[11px] text-gray-400'>Foliage kept off this material even where a neighbouring material would place it.</p>
          {knownFoliageNames.length === 0 && <p className='text-[11px] text-gray-500'>No foliage defined in the library yet.</p>}
          {knownFoliageNames.map(name => (
            <div key={name} className='flex items-center justify-between'>
              <span className={label}>{name}</span>
              <Toggle checked={mat.foliageExclude.includes(name)} onChange={c => toggleExclude(name, c)} />
            </div>
          ))}
        </div>
      </Collapsable>
    </div>
  )
}
