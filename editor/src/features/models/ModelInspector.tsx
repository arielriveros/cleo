import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'

// The right-sidebar inspector shown while a model tab is active: asset name, LOD levels (each a
// reference to another model asset plus the camera distance where it takes over) and the distance-cull
// threshold. A model's parts, transforms and material are edited through the normal Scene + Properties
// panels; this panel owns only what lives on the ModelAsset itself. Saved with "Save Model".
export default function ModelInspector() {
  const {
    activeTab, modelSession, setActiveModelName, models,
    addModelLodFromAsset, removeModelLod, setModelLodDistance, setModelCullDistance, setActiveModelLevel,
  } = useCleoEngine()

  if (!modelSession) return null

  // Models selectable as a level: not this model (a model cannot be its own level) and not one already used.
  const candidates = models.filter(m =>
    m.id !== activeTab.modelId && !modelSession.lodRefs.some(l => l.modelId === m.id))
  const nameOf = (modelId?: string) => modelId ? (models.find(m => m.id === modelId)?.name ?? 'missing model') : 'embedded (legacy)'

  const label = 'text-xs text-slate-300'
  const num = 'w-16 bg-control text-white border border-border rounded px-1 py-[2px] text-xs'

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full'>
      <div className='p-2 border-b border-border'>
        <label className='text-xs text-slate-300 block mb-1'>Model name</label>
        <input
          className='bg-control text-white border border-border rounded px-2 py-1 w-full text-sm'
          value={activeTab.title}
          onChange={e => setActiveModelName(e.target.value)} />
      </div>

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
