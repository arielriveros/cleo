import { useEffect, useState } from 'react'
import { applyManualMapping } from 'cleo'
import type { BoneMapping, BoneMatchKind } from 'cleo'
import { useEditorSessions } from '../EditorSessionsContext'
import { Modal, ModalHeader, ModalFooter, Toggle } from '../../components/ui'

// Review modal for importing animation clips: a SKELETON mapping (which source bone drives which target
// joint) and the CLIP list. Clip counts are recomputed from the live mapping, so a mapping fix shows its
// effect before Accept, which is where EngineContext runs the retarget.

const KIND_LABEL: Record<BoneMatchKind, string> = {
  exact: 'exact', normalized: 'name', humanoid: 'auto', spine: 'spine', index: 'index', manual: 'manual', none: '—',
}
const KIND_STYLE: Record<BoneMatchKind, string> = {
  exact: 'bg-success/15 text-green-300',
  normalized: 'bg-success/15 text-green-300',
  humanoid: 'bg-primary/15 text-primary',
  spine: 'bg-primary/15 text-primary',
  index: 'bg-warning/15 text-warning',
  manual: 'bg-highlight/20 text-highlight',
  none: 'bg-red-900 text-red-300',
}

/**
 * The name to seed the rename box with. Mixamo clips are all called `mixamo.com` and nameless glTF
 * animations parse as `Animation`; for those two the file name is used instead.
 */
function defaultClipName(clipName: string, fileName: string): string {
  const generic = clipName === 'mixamo.com' || clipName === 'Animation' || !clipName.trim()
  if (!generic) return clipName
  // `fileName` is a File.name — a bare basename — so only the extension needs stripping.
  const base = fileName.replace(/\.[^.]+$/, '').trim()
  return base || clipName
}

export default function AnimationImportModal() {
  const { pendingAnimationImport, resolveAnimationImport } = useEditorSessions()
  const [include, setInclude] = useState<boolean[]>([])
  // Per-clip name, editable before commit. Animation Field samples reference clips by name and are NOT
  // rewritten by a later rename, so renaming must happen here.
  const [names, setNames] = useState<string[]>([])
  // Working copy of the mapping; committed back on Accept.
  const [mapping, setMapping] = useState<BoneMapping | null>(null)
  const [showMap, setShowMap] = useState(false)

  useEffect(() => {
    setInclude(pendingAnimationImport ? pendingAnimationImport.clips.map(c => c.report.compatible) : [])
    setNames(pendingAnimationImport ? pendingAnimationImport.clips.map(c => defaultClipName(c.name, pendingAnimationImport.fileName)) : [])
    setMapping(pendingAnimationImport?.mapping ?? null)
    setShowMap(false)
  }, [pendingAnimationImport])

  if (!pendingAnimationImport || !mapping) return null
  const info = pendingAnimationImport
  const anyIndexMode = mapping.matchMode === 'index'
  const chosen = include.filter(Boolean).length

  const accept = () => resolveAnimationImport({ include, mapping, names })
  const cancel = () => resolveAnimationImport(null)
  const toggle = (i: number) => setInclude(prev => prev.map((v, idx) => idx === i ? !v : v))
  const rename = (i: number, value: string) => setNames(prev => prev.map((v, idx) => idx === i ? value : v))

  // Names that two or more SELECTED clips share: the second to be added silently becomes "name (2)".
  const duplicated = new Set(
    names
      .map((n, i) => (include[i] ? n.trim().toLowerCase() : ''))
      .filter((n, i, all) => n !== '' && all.indexOf(n) !== i),
  )
  const remap = (sourceNode: number, targetNode: number | null) =>
    setMapping(prev => (prev ? applyManualMapping(prev, sourceNode, targetNode) : prev))

  /** Source bones in `nodes` that the LIVE mapping sends nowhere, by name. */
  const unmappedNames = (nodes: number[]): string[] =>
    nodes.filter(n => (targetOf.get(n) ?? null) === null)
      .map(n => info.sourceBones.find(b => b.node === n)?.name ?? `node ${n}`)

  // Source bone → target joint from the LIVE mapping; clip counts read through this.
  const targetOf = new Map(mapping.entries.map(e => [e.sourceNode, e.targetNode] as const))
  const mappedCount = mapping.entries.filter(e => e.targetNode !== null).length
  const autoCount = mapping.entries.filter(e => e.kind === 'humanoid' || e.kind === 'normalized' || e.kind === 'spine').length
  const exactCount = mapping.entries.filter(e => e.kind === 'exact').length
  const unmappedCount = mapping.entries.length - mappedCount

  // Unmapped rows first: those are the ones needing attention.
  const rows = [...mapping.entries].sort((a, b) => (a.targetNode === null ? 0 : 1) - (b.targetNode === null ? 0 : 1))

  return (
    <Modal onClose={cancel} className='w-[640px]'>
      <ModalHeader>
        <div className='text-sm font-semibold'>Import animation</div>
        <div className='text-lg font-bold truncate' title={info.fileName}>{info.fileName}</div>
        <div className='text-xs text-gray-400 mt-0.5'>{info.clips.length} clip{info.clips.length === 1 ? '' : 's'} found</div>
      </ModalHeader>

      <div className='px-4 py-3 space-y-3 text-sm max-h-[60vh] overflow-y-auto'>
        {anyIndexMode ? (
          <p className='text-[11px] text-warning bg-warning/15 rounded px-2 py-1'>
            This model has no stored bone names, so clips are matched by node index (only works for the same export).
            Re-import the model to enable name-based matching and retargeting.
          </p>
        ) : (
          <div className='rounded border border-control'>
            <button className='w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-control/40'
              onClick={() => setShowMap(!showMap)}>
              <span className='text-[11px]'>{showMap ? '▾' : '▸'}</span>
              <span className='font-semibold text-[12px] flex-1'>Skeleton</span>
              {mapping.sameRig
                ? <span className='text-[11px] text-green-300'>same rig — no retargeting needed</span>
                : <span className='text-[11px] text-gray-300'>
                    {mappedCount}/{mapping.entries.length} mapped
                    {exactCount ? ` · ${exactCount} exact` : ''}
                    {autoCount ? ` · ${autoCount} auto` : ''}
                    {unmappedCount ? ` · ${unmappedCount} unmapped` : ''}
                  </span>}
            </button>

            {showMap && (
              <div className='border-t border-control max-h-[220px] overflow-y-auto'>
                {rows.map(e => (
                  <div key={e.sourceNode} className='flex items-center gap-2 px-2 py-1 text-[11px] border-b border-control/50 last:border-0'>
                    <span className='flex-1 truncate' title={e.sourceName ?? `node ${e.sourceNode}`}>{e.sourceName ?? `node ${e.sourceNode}`}</span>
                    <span className={`px-1.5 py-0.5 rounded shrink-0 ${KIND_STYLE[e.kind]}`}>{KIND_LABEL[e.kind]}</span>
                    <span className='text-dim shrink-0'>→</span>
                    <select
                      className='bg-control text-white border border-control-hover rounded px-1 py-0.5 w-[190px] shrink-0'
                      value={e.targetNode ?? ''}
                      onChange={ev => remap(e.sourceNode, ev.target.value === '' ? null : Number(ev.target.value))}>
                      <option value=''>— none —</option>
                      {info.targetBones.map(b => <option key={b.node} value={b.node}>{b.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {info.clips.map((c, i) => {
          // Recount this clip's bones against the LIVE mapping, so a fix above updates the card at once.
          const animated = c.animatedNodes.length
          const matched = c.animatedNodes.filter(n => (targetOf.get(n) ?? null) !== null).length
          const compatible = matched > 0
          return (
            <div key={i} className={`rounded border p-2 ${compatible ? 'border-control' : 'border-red-700 bg-danger/10'}`}>
              <div className='flex items-center gap-2'>
                <span title={compatible ? 'Include this clip' : 'No matching bones — cannot import'}>
                  <Toggle checked={!!include[i]} disabled={!compatible} onChange={() => toggle(i)} />
                </span>
                <input
                  className='flex-1 min-w-0 bg-surface-raised border border-control rounded px-2 py-1 text-xs font-semibold text-white disabled:opacity-50'
                  value={names[i] ?? ''}
                  disabled={!compatible}
                  onChange={e => rename(i, e.target.value)}
                  title={`Imported as this name. Parsed from the file as "${c.name}".`}
                />
                <span className={`text-[11px] px-1.5 py-0.5 rounded ${compatible ? 'bg-success/15 text-green-300' : 'bg-red-900 text-red-300'}`}>
                  {compatible ? (mapping.sameRig ? '✓ compatible' : '✓ retargeted') : '✗ incompatible'}
                </span>
              </div>
              <div className='mt-1 text-[11px] text-gray-300'>
                {matched}/{animated} bones mapped
              </div>
              {/* An unmapped bone's curve is DROPPED at commit and the target bone silently keeps its rest
                  pose — which reads as a limb rotated by a fixed amount rather than as a missing channel.
                  Naming them here is the difference between noticing that in the modal and chasing it in
                  the viewport. */}
              {compatible && matched < animated && (
                <div className='mt-1 text-[11px] text-warning' title={unmappedNames(c.animatedNodes).join(', ')}>
                  {animated - matched} bone{animated - matched === 1 ? '' : 's'} unmapped — their motion is
                  dropped: {unmappedNames(c.animatedNodes).slice(0, 4).join(', ')}
                  {animated - matched > 4 ? `, +${animated - matched - 4} more` : ''}
                </div>
              )}
              {compatible && include[i] && !(names[i] ?? '').trim() && (
                <div className='mt-1 text-[11px] text-warning'>
                  A blank name imports as “clip”. Type one to keep it findable.
                </div>
              )}
              {compatible && include[i] && duplicated.has((names[i] ?? '').trim().toLowerCase()) && (
                <div className='mt-1 text-[11px] text-warning'>
                  Another selected clip has this name — the second will be imported as “{(names[i] ?? '').trim()} (2)”.
                </div>
              )}
              {!compatible && (
                <div className='mt-1 text-[11px] text-red-200'>
                  No source bone maps to the skeleton. Open <b>Skeleton</b> above and map at least the hips.
                </div>
              )}
            </div>
          )
        })}
      </div>

      <ModalFooter className='justify-between items-center'>
        <span className='text-[11px] text-gray-400'>{chosen} selected</span>
        <div className='flex gap-2'>
          <button className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover' onClick={cancel}>Cancel</button>
          <button className='px-3 py-1.5 text-xs rounded bg-success hover:bg-success-hover font-semibold disabled:opacity-40 disabled:cursor-not-allowed'
            disabled={chosen === 0} onClick={accept}>Add {chosen > 0 ? `${chosen} ` : ''}clip{chosen === 1 ? '' : 's'}</button>
        </div>
      </ModalFooter>
    </Modal>
  )
}
