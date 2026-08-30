import { useState } from 'react'
import { TextureManager } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import GenerateLodsModal, { defaultSpecs, type GenerateLodsSpec } from './GenerateLodsModal'
import { modelAssetTextureIds } from '../../utils/models'

/** Triangles in a serialized model subtree, for the generate dialog's before/after figures. */
function countTriangles(nodeJson: any): number {
  if (!nodeJson || typeof nodeJson !== 'object') return 0
  let n = Math.floor((nodeJson.model?.geometry?.indices?.length ?? 0) / 3)
  for (const child of nodeJson.children ?? []) n += countTriangles(child)
  return n
}

// Right-sidebar inspector for the active model tab: asset name, LOD levels (each another model asset
// plus the camera distance where it takes over) and the distance-cull threshold.
export default function ModelInspector() {
  const {
    activeTab, modelSession, setActiveModelName, models,
    addModelLodFromAsset, generateModelLods, removeModelLod, setModelLodDistance, setModelCullDistance,
    setActiveModelLevel, animationFields, createAnimationFieldForModel, enterAnimationFieldEditor,
  } = useCleoEngine()

  const [generating, setGenerating] = useState(false)

  if (!modelSession) return null

  const fields = animationFields.filter(f => f.modelId === activeTab.modelId)

  // A model may not be its own LOD level, nor appear twice.
  const candidates = models.filter(m =>
    m.id !== activeTab.modelId && !modelSession.lodRefs.some(l => l.modelId === m.id))
  const nameOf = (modelId?: string) => modelId ? (models.find(m => m.id === modelId)?.name ?? 'missing model') : 'embedded (legacy)'

  // Read off the SAVED asset rather than the live tab scene: the modal only needs figures to quote, and
  // the asset is what generation will actually reduce.
  const asset = models.find(m => m.id === activeTab.modelId)
  const sourceTriangles = countTriangles(asset?.nodeJson)
  const largestTexture = (asset ? modelAssetTextureIds(asset) : []).reduce((max, id) => {
    const image = TextureManager.Instance.getTexture(id)?.data as HTMLImageElement | undefined
    return Math.max(max, image?.naturalWidth ?? 0, image?.naturalHeight ?? 0)
  }, 0)

  const label = 'text-xs text-slate-300'
  const num = 'w-16 bg-control text-white border border-border rounded px-1 py-[2px] text-xs'

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full'>
      {generating && (
        <GenerateLodsModal
          modelName={activeTab.title}
          sourceTriangles={sourceTriangles}
          largestTexture={largestTexture}
          initial={defaultSpecs(2)}
          onCancel={() => setGenerating(false)}
          onGenerate={(specs: GenerateLodsSpec[], downscale: boolean) => {
            setGenerating(false)
            void generateModelLods(specs, downscale)
          }} />
      )}
      <div className='p-2 border-b border-border'>
        <label className='text-xs text-slate-300 block mb-1'>Model name</label>
        <input
          className='bg-control text-white border border-border rounded px-2 py-1 w-full text-sm'
          value={activeTab.title}
          onChange={e => setActiveModelName(e.target.value)} />
      </div>

      {/* Blend spaces belong to a skinned model, which is exactly what this tab has open — so this is the
          natural place to create one. Static models have no clips to blend. */}
      {modelSession.skinned && activeTab.modelId && (
        <Collapsable title='Animation fields' badge={fields.length || undefined} defaultOpen>
          <div className='p-2 space-y-1'>
            <p className='text-[11px] text-gray-400'>
              A field blends this model’s clips by 1D or 2D parameters. Use one as a state in the
              animation graph instead of a single clip.
            </p>
            {fields.map(f => (
              <button key={f.id}
                className='w-full rounded border border-control-hover px-2 py-1 text-left text-xs hover:bg-control'
                onClick={() => enterAnimationFieldEditor(f.id)}
                title={`Open the "${f.name}" blend space`}>
                ⊞ {f.name}
              </button>
            ))}
            <button
              className='w-full rounded border border-control-hover px-2 py-1 text-xs hover:bg-control'
              onClick={() => createAnimationFieldForModel(activeTab.modelId!)}
              title='Create a new blend space from this model'>
              + New Animation Field
            </button>
          </div>
        </Collapsable>
      )}

      <Collapsable title='LOD levels'>
        <div className='p-2 space-y-2'>
          {modelSession.skinned ? (
            <p className='text-[11px] text-gray-400'>LOD levels are not available for skinned models.</p>
          ) : (
            <>
              <p className='text-[11px] text-gray-400'>
                Each level references another model from the library and takes over at its distance —
                editing that model updates every level using it. Only LOD0 is edited here; selecting a
                level just previews it.
              </p>
              {modelSession.levelIds.map((_, i) => (
                <div key={i} className='border border-control rounded p-2 space-y-1'>
                  <div className='flex items-center gap-2'>
                    <label className='flex items-center gap-1 cursor-pointer flex-1'>
                      <input
                        type='radio'
                        name='activeModelLevel'
                        checked={modelSession.activeLevel === i}
                        onChange={() => setActiveModelLevel(i)} />
                      <span className={label}>{i === 0 ? 'LOD0 (base)' : `LOD${i}`}</span>
                    </label>
                    {i > 0 && (
                      <button className='text-red-300 text-xs px-1' onClick={() => removeModelLod(i)} title='Remove this level'>✕</button>
                    )}
                  </div>
                  {i > 0 && (
                    <>
                      <div className='flex items-center justify-between'>
                        <span className={label}>Model</span>
                        <span className='text-[11px] text-slate-400 truncate max-w-[55%]' title={nameOf(modelSession.lodRefs[i - 1]?.modelId)}>
                          {nameOf(modelSession.lodRefs[i - 1]?.modelId)}
                        </span>
                      </div>
                      <div className='flex items-center justify-between'>
                        <span className={label}>From distance</span>
                        <input
                          type='number' min={0} className={num}
                          value={modelSession.distances[i] ?? 0}
                          onChange={e => setModelLodDistance(i, Number(e.target.value))} />
                      </div>
                    </>
                  )}
                </div>
              ))}
              <button
                className='w-full text-xs bg-primary hover:bg-primary-hover rounded px-2 py-1.5 font-semibold disabled:opacity-40'
                disabled={sourceTriangles === 0}
                title={sourceTriangles === 0
                  ? 'This model has no geometry to reduce'
                  : 'Decimate this model into reduced levels, with half-resolution textures'}
                onClick={() => setGenerating(true)}>
                Generate LOD levels…
              </button>

              {candidates.length > 0 ? (
                <select
                  className='w-full bg-control text-white border border-border rounded px-2 py-1 text-xs'
                  value=''
                  onChange={e => { if (e.target.value) addModelLodFromAsset(e.target.value); e.target.value = '' }}>
                  <option value=''>Add LOD level from model…</option>
                  {candidates.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              ) : (
                <p className='text-[11px] text-gray-400'>
                  No other models available — import a lower-poly model into the library to use it as a level.
                </p>
              )}
            </>
          )}

          {!modelSession.skinned && (
            <div className='flex items-center justify-between pt-1 border-t border-control'>
              <span className={label} title='Placed copies disappear beyond this camera distance. 0 = never cull.'>
                Cull distance (0 = never)
              </span>
              <input
                type='number' min={0} className={num}
                value={modelSession.cullDistance}
                onChange={e => setModelCullDistance(Number(e.target.value))} />
            </div>
          )}
        </div>
      </Collapsable>
    </div>
  )
}
