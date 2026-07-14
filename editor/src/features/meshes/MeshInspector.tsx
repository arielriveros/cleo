import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'

// The right-sidebar inspector shown while a mesh tab is active: asset name, LOD levels (imported from
// separate files, each with the camera distance where it takes over) and the distance-cull threshold.
// Sub-meshes, transforms and materials are edited through the normal Scene + Properties panels; this
// panel owns only what lives on the MeshAsset itself. Saved with "Save Mesh" in the menu bar.
export default function MeshInspector() {
  const {
    activeTab, meshSession, setActiveMeshName,
    addMeshLodFromFiles, removeMeshLod, setMeshLodDistance, setMeshCullDistance, setActiveMeshLevel,
  } = useCleoEngine()

  if (!meshSession) return null

  const label = 'text-xs text-slate-300'
  const num = 'w-16 bg-control text-white border border-border rounded px-1 py-[2px] text-xs'

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full'>
      <div className='p-2 border-b border-border'>
        <label className='text-xs text-slate-300 block mb-1'>Mesh name</label>
        <input
          className='bg-control text-white border border-border rounded px-2 py-1 w-full text-sm'
          value={activeTab.title}
          onChange={e => setActiveMeshName(e.target.value)} />
      </div>

      <Collapsable title='LOD levels'>
        <div className='p-2 space-y-2'>
          {meshSession.skinned ? (
            <p className='text-[11px] text-gray-400'>LOD levels are not available for skinned meshes.</p>
          ) : (
            <>
              <p className='text-[11px] text-gray-400'>
                Each level is imported from its own model file and takes over at its distance. The shown
                level is the one you edit in the Scene panel.
              </p>
              {meshSession.levelIds.map((_, i) => (
                <div key={i} className='border border-control rounded p-2 space-y-1'>
                  <div className='flex items-center gap-2'>
                    <label className='flex items-center gap-1 cursor-pointer flex-1'>
                      <input
                        type='radio'
                        name='activeMeshLevel'
                        checked={meshSession.activeLevel === i}
                        onChange={() => setActiveMeshLevel(i)} />
                      <span className={label}>{i === 0 ? 'LOD0 (base)' : `LOD${i}`}</span>
                    </label>
                    {i > 0 && (
                      <button className='text-red-300 text-xs px-1' onClick={() => removeMeshLod(i)} title='Remove this level'>✕</button>
                    )}
                  </div>
                  {i > 0 && (
                    <div className='flex items-center justify-between'>
                      <span className={label}>From distance</span>
                      <input
                        type='number' min={0} className={num}
                        value={meshSession.distances[i] ?? 0}
                        onChange={e => setMeshLodDistance(i, Number(e.target.value))} />
                    </div>
                  )}
                </div>
              ))}
              <label className='block bg-control hover:bg-control-hover rounded px-2 py-1 text-xs text-center cursor-pointer'>
                Add LOD from file
                <input
                  type='file' className='hidden' accept='.obj,.gltf,.glb,.fbx' multiple
                  onChange={e => { if (e.target.files?.length) void addMeshLodFromFiles(Array.from(e.target.files)); e.target.value = '' }} />
              </label>
            </>
          )}

          {!meshSession.skinned && (
            <div className='flex items-center justify-between pt-1 border-t border-control'>
              <span className={label} title='Placed copies disappear beyond this camera distance. 0 = never cull.'>
                Cull distance (0 = never)
              </span>
              <input
                type='number' min={0} className={num}
                value={meshSession.cullDistance}
                onChange={e => setMeshCullDistance(Number(e.target.value))} />
            </div>
          )}
        </div>
      </Collapsable>
    </div>
  )
}
