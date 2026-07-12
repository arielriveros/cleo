import { useMemo, useState } from 'react'
import { Node, ModelNode, TerrainMaterial, TerrainFoliageRule, Model, TextureManager } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import MaterialEditor from '../nodeInspector/propertyEditors/MaterialEditor'
import TextureInspector from '../nodeInspector/propertyEditors/TextureInspector'

// The right-sidebar inspector shown while a terrain-material tab is active. Edits the preview sphere's
// TerrainMaterial in place: the base surface (via the shared MaterialEditor), the terrain blend fields,
// and the foliage include/exclude lists. All edits emit SCENE_CHANGED so the tab tracks unsaved state.
export default function TerrainMaterialInspector(props: { node: Node | null }) {
  const { eventEmitter, editingTerrainMaterialName, setActiveTerrainMaterialName, terrainMaterials } = useCleoEngine()
  const [, force] = useState(0)
  const [newFoliageTex, setNewFoliageTex] = useState('')
  const rerender = () => force(x => x + 1)

  const node = props.node
  const tm = node && node.nodeType === 'model' ? ((node as ModelNode).model?.material as TerrainMaterial | undefined) : undefined
  const isTerrain = tm instanceof TerrainMaterial

  // Union of foliage prototype names across the library (+ this material's own) for the exclude picker.
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

  const changed = () => { eventEmitter.emit('SCENE_CHANGED'); rerender() }

  const label = 'text-xs text-slate-300'
  const num = 'w-16 bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-1 py-[2px] text-xs'

  if (!isTerrain) {
    return <div className='p-3 text-xs text-gray-400'>Open a terrain material to edit it.</div>
  }
  const mat = tm!

  const addBillboard = () => {
    if (!newFoliageTex) { alert('Pick a texture for the grass billboard.'); return }
    const name = `${newFoliageTex.slice(0, 10)}_${mat.foliageInclude.length}`
    mat.foliageInclude.push({ kind: 'billboard', name, textureId: newFoliageTex, density: 8, minScale: 0.8, maxScale: 1.4 })
    changed()
  }
  const addMesh = (files: FileList | null) => {
    if (!files || files.length === 0) return
    Model.fromFile({ files: Array.from(files) }).then(models => {
      if (!models.length) return
      const rule: TerrainFoliageRule = {
        kind: 'mesh', name: `${models[0].name}_${mat.foliageInclude.length}`,
        model: models[0].model.serialize(), density: 4, minScale: 0.8, maxScale: 1.4,
      }
      mat.foliageInclude.push(rule)
      changed()
    }).catch(err => console.error(err))
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
    <div className='flex flex-col text-white bg-[#202020] w-full h-full overflow-y-auto'>
      <div className='p-2 border-b border-[#2d5d2d]'>
        <label className='text-xs text-slate-300 block mb-1'>Terrain material name</label>
        <input
          className='bg-[#3b3b3b] text-white border border-[#2d5d2d] rounded px-2 py-1 w-full text-sm'
          value={editingTerrainMaterialName ?? ''}
          onChange={(e) => setActiveTerrainMaterialName(e.target.value)} />
      </div>

      {/* Base surface (Basic / Blinn-Phong / PBR) — mutates the TerrainMaterial in place. */}
      {node && node.nodeType === 'model' &&
        <div onChange={() => eventEmitter.emit('SCENE_CHANGED')}>
          <MaterialEditor node={node as ModelNode} />
        </div>}

      <Collapsable title='Terrain blend'>
        <div className='p-2 space-y-2'>
          <div className='flex items-center justify-between'>
            <span className={label}>Tiling</span>
            <input type='number' className={num} value={mat.tiling} onChange={e => { mat.tiling = Number(e.target.value); changed() }} />
          </div>
          <label className='flex items-center justify-between cursor-pointer'>
            <span className={label}>Auto height/slope</span>
            <input type='checkbox' checked={mat.auto} onChange={e => { mat.auto = e.target.checked; changed() }} />
          </label>
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
          <div className='pt-1 border-t border-[#3b3b3b] space-y-1'>
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
          <div className='border border-[#3b3b3b] rounded p-2 space-y-1'>
            <div className={label}>Add grass billboard</div>
            <div className='flex gap-1'>
              <select className={`${num} flex-1`} value={newFoliageTex} onChange={e => setNewFoliageTex(e.target.value)}>
                <option value=''>(texture)</option>
                {textureIds.map(id => <option key={id} value={id}>{id.length > 16 ? id.slice(0, 15) + '…' : id}</option>)}
              </select>
              <button className='bg-[#2c7a2c] hover:bg-[#358535] rounded px-2 text-xs' onClick={addBillboard}>+</button>
            </div>
            <label className='block bg-[#3b3b3b] hover:bg-[#4a4a4a] rounded px-2 py-1 text-xs text-center cursor-pointer'>
              Add mesh prop (import)
              <input type='file' className='hidden' accept='.obj,.gltf,.glb' multiple onChange={e => addMesh(e.target.files)} />
            </label>
          </div>

          {mat.foliageInclude.map((r, i) => (
            <div key={i} className='border border-[#3b3b3b] rounded p-2 space-y-1'>
              <div className='flex items-center gap-1'>
                <input className={`${num} flex-1`} value={r.name} onChange={e => patchRule(i, { name: e.target.value })} title='Foliage name (referenced by exclude lists)' />
                <span className='text-[10px] text-gray-400'>{r.kind}</span>
                <button className='text-red-300 text-xs px-1' onClick={() => removeRule(i)} title='Remove'>✕</button>
              </div>
              <div className='flex items-center justify-between'>
                <span className={label}>Density</span>
                <input type='number' className={num} value={r.density ?? 8} onChange={e => patchRule(i, { density: Number(e.target.value) })} />
              </div>
              <div className='flex items-center justify-between'>
                <span className={label}>Scale min/max</span>
                <span className='flex gap-1'>
                  <input type='number' step={0.1} className={num} value={r.minScale ?? 0.8} onChange={e => patchRule(i, { minScale: Number(e.target.value) })} />
                  <input type='number' step={0.1} className={num} value={r.maxScale ?? 1.4} onChange={e => patchRule(i, { maxScale: Number(e.target.value) })} />
                </span>
              </div>
            </div>
          ))}
        </div>
      </Collapsable>

      <Collapsable title='Exclude foliage'>
        <div className='p-2 space-y-1'>
          <p className='text-[11px] text-gray-400'>Foliage kept off this material even where a neighbouring material would place it.</p>
          {knownFoliageNames.length === 0 && <p className='text-[11px] text-gray-500'>No foliage defined in the library yet.</p>}
          {knownFoliageNames.map(name => (
            <label key={name} className='flex items-center justify-between cursor-pointer'>
              <span className={label}>{name}</span>
              <input type='checkbox' checked={mat.foliageExclude.includes(name)} onChange={e => toggleExclude(name, e.target.checked)} />
            </label>
          ))}
        </div>
      </Collapsable>
    </div>
  )
}
