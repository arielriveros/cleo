import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'

// Centered review modal for importing animation clips. For each clip parsed from the file it shows a
// compatibility report vs the model's skeleton — matched/total bones, target coverage, and (when
// incompatible) the specific bones that are missing or whose parent relationship differs. The user
// picks which clips to add. Mounted globally in Editor so it overlays the whole editor.
export default function AnimationImportModal() {
  const { pendingAnimationImport, resolveAnimationImport } = useCleoEngine()
  const [include, setInclude] = useState<boolean[]>([])

  // Default: include every clip that matched at least one bone.
  useEffect(() => {
    setInclude(pendingAnimationImport ? pendingAnimationImport.clips.map(c => c.report.compatible) : [])
  }, [pendingAnimationImport])

  if (!pendingAnimationImport) return null
  const info = pendingAnimationImport
  const anyIndexMode = info.clips.some(c => c.report.matchMode === 'index')
  const chosen = include.filter(Boolean).length

  const accept = () => resolveAnimationImport({ include })
  const cancel = () => resolveAnimationImport(null)
  const toggle = (i: number) => setInclude(prev => prev.map((v, idx) => idx === i ? !v : v))

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={cancel}>
      <div className='w-[480px] max-h-[85vh] overflow-y-auto bg-[#252525] border border-[#3b3b3b] rounded-md shadow-lg text-white select-none'
           onClick={(e) => e.stopPropagation()}>
        <div className='px-4 py-3 border-b border-[#3b3b3b]'>
          <div className='text-sm font-semibold'>Import animation</div>
          <div className='text-lg font-bold truncate' title={info.fileName}>{info.fileName}</div>
          <div className='text-xs text-gray-400 mt-0.5'>{info.clips.length} clip{info.clips.length === 1 ? '' : 's'} found</div>
        </div>

        <div className='px-4 py-3 space-y-3 text-sm'>
          {anyIndexMode && (
            <p className='text-[11px] text-[#ffd27a] bg-[#3a2f12] rounded px-2 py-1'>
              This model has no stored bone names, so clips are matched by node index (only works for the same export).
              Re-import the model to enable name-based matching.
            </p>
          )}

          {info.clips.map((c, i) => {
            const r = c.report
            return (
              <div key={i} className={`rounded border p-2 ${r.compatible ? 'border-[#3b3b3b]' : 'border-red-700 bg-[#2a1414]'}`}>
                <div className='flex items-center gap-2'>
                  <input type='checkbox' checked={!!include[i]} disabled={!r.compatible}
                         onChange={() => toggle(i)} title={r.compatible ? 'Include this clip' : 'No matching bones — cannot import'} />
                  <span className='font-semibold flex-1 truncate' title={c.name}>{c.name}</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${r.compatible ? 'bg-[#194d19] text-green-300' : 'bg-red-900 text-red-300'}`}>
                    {r.compatible ? '✓ compatible' : '✗ incompatible'}
                  </span>
                </div>

                <div className='mt-1 flex gap-4 text-[11px] text-gray-300'>
                  <span>{r.matchedBones}/{r.animatedBones} bones matched</span>
                  <span>{r.targetCovered}/{r.targetJointCount} skeleton joints driven</span>
                </div>

                {r.missingBones.length > 0 && (
                  <div className='mt-1'>
                    <div className='text-[11px] text-red-300'>Missing from skeleton ({r.missingBones.length}):</div>
                    <div className='text-[11px] text-red-200 break-words'>{r.missingBones.join(', ')}</div>
                  </div>
                )}

                {r.hierarchyMismatches.length > 0 && (
                  <div className='mt-1'>
                    <div className='text-[11px] text-[#ffd27a]'>Different parent relationship ({r.hierarchyMismatches.length}):</div>
                    <div className='text-[11px] text-[#ffd27a]/90 space-y-0.5'>
                      {r.hierarchyMismatches.map((h, hi) => (
                        <div key={hi}>{h.bone}: parent <b>{h.sourceParent ?? '—'}</b> → skeleton has <b>{h.targetParent ?? '—'}</b></div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className='px-4 py-3 border-t border-[#3b3b3b] flex justify-between items-center gap-2'>
          <span className='text-[11px] text-gray-400'>{chosen} selected</span>
          <div className='flex gap-2'>
            <button className='px-3 py-1.5 text-xs rounded bg-[#3b3b3b] hover:bg-[#4b4b4b]' onClick={cancel}>Cancel</button>
            <button className='px-3 py-1.5 text-xs rounded bg-[#2c7a2c] hover:bg-[#358535] font-semibold disabled:opacity-40 disabled:cursor-not-allowed'
                    disabled={chosen === 0} onClick={accept}>Add {chosen > 0 ? `${chosen} ` : ''}clip{chosen === 1 ? '' : 's'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
