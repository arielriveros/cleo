import { useEffect, useState } from 'react'
import { applyManualMapping } from 'cleo'
import type { BoneMapping } from 'cleo'
import { useEditorSessions } from '../EditorSessionsContext'
import { Button, cn, hintClass, Modal, ModalHeader, ModalFooter, TextInput, Toggle } from '../../components/ui'
import BoneMappingTable from './BoneMappingTable'
// Shared with the model-import route: a placeholder clip name is renamed after its file in BOTH
// places, so the same download names its clip the same way whichever door it came in through.
import { clipNameFromFile } from '../../utils/clipNaming'

// Review modal for importing animation clips: a SKELETON mapping (which source bone drives which target
// joint) and the CLIP list. Clip counts are recomputed from the live mapping, so a mapping fix shows its
// effect before Accept, which is where EngineContext runs the retarget.

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
    setNames(pendingAnimationImport ? pendingAnimationImport.clips.map(c => clipNameFromFile(c.name, pendingAnimationImport.fileName)) : [])
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

  return (
    <Modal onClose={cancel} className='w-[640px]'>
      <ModalHeader>
        <div className='text-ui-lg font-semibold'>Import animation</div>
        <div className='text-ui-lg font-bold truncate' title={info.fileName}>{info.fileName}</div>
        <div className={cn(hintClass, 'mt-0.5')}>{info.clips.length} clip{info.clips.length === 1 ? '' : 's'} found</div>
      </ModalHeader>

      <div className='px-4 py-3 space-y-3 text-ui max-h-[60vh] overflow-y-auto'>
        {anyIndexMode ? (
          <p className='text-ui-sm text-warning bg-warning/15 rounded px-2 py-1'>
            This model has no stored bone names, so clips are matched by node index (only works for the same export).
            Re-import the model to enable name-based matching and retargeting.
          </p>
        ) : (
          <div className='rounded border border-control'>
            <button className='w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-control/40'
              onClick={() => setShowMap(!showMap)}>
              <span className='text-ui-sm'>{showMap ? '▾' : '▸'}</span>
              <span className='font-semibold text-ui flex-1'>Skeleton</span>
              {mapping.sameRig
                ? <span className='text-ui-sm text-success-fg'>same rig — no retargeting needed</span>
                : <span className='text-ui-sm text-muted'>
                    {mappedCount}/{mapping.entries.length} mapped
                    {exactCount ? ` · ${exactCount} exact` : ''}
                    {autoCount ? ` · ${autoCount} auto` : ''}
                    {unmappedCount ? ` · ${unmappedCount} unmapped` : ''}
                  </span>}
            </button>

            {showMap && (
              // The rig editor's table: one vocabulary (kind chips, unmapped first, "— none —") in both places.
              <BoneMappingTable mapping={mapping} targetBones={info.targetBones} onRemap={remap}
                className='border-t border-control max-h-[220px] overflow-y-auto' />
            )}
          </div>
        )}

        {info.clips.map((c, i) => {
          // Recount this clip's bones against the LIVE mapping, so a fix above updates the card at once.
          const animated = c.animatedNodes.length
          const matched = c.animatedNodes.filter(n => (targetOf.get(n) ?? null) !== null).length
          const compatible = matched > 0
          return (
            <div key={i} className={`rounded border p-2 ${compatible ? 'border-control' : 'border-danger-border bg-danger/10'}`}>
              <div className='flex items-center gap-2'>
                <span title={compatible ? 'Include this clip' : 'No matching bones — cannot import'}>
                  <Toggle checked={!!include[i]} disabled={!compatible} onChange={() => toggle(i)} />
                </span>
                <TextInput
                  className='flex-1 min-w-0 font-semibold disabled:opacity-50'
                  value={names[i] ?? ''}
                  disabled={!compatible}
                  onChange={v => rename(i, v)}
                  title={`Imported as this name. Parsed from the file as "${c.name}".`}
                />
                <span className={`text-ui-sm px-1.5 py-0.5 rounded ${compatible ? 'bg-success/15 text-success-fg' : 'bg-danger-surface text-danger-fg'}`}>
                  {compatible ? (mapping.sameRig ? '✓ compatible' : '✓ retargeted') : '✗ incompatible'}
                </span>
              </div>
              <div className='mt-1 text-ui-sm text-muted'>
                {matched}/{animated} bones mapped
              </div>
              {/* An unmapped bone's curve is DROPPED at commit and the target bone silently keeps its rest
                  pose — which reads as a limb rotated by a fixed amount rather than as a missing channel.
                  Naming them here is the difference between noticing that in the modal and chasing it in
                  the viewport. */}
              {compatible && matched < animated && (
                <div className='mt-1 text-ui-sm text-warning' title={unmappedNames(c.animatedNodes).join(', ')}>
                  {animated - matched} bone{animated - matched === 1 ? '' : 's'} unmapped — their motion is
                  dropped: {unmappedNames(c.animatedNodes).slice(0, 4).join(', ')}
                  {animated - matched > 4 ? `, +${animated - matched - 4} more` : ''}
                </div>
              )}
              {compatible && include[i] && !(names[i] ?? '').trim() && (
                <div className='mt-1 text-ui-sm text-warning'>
                  A blank name imports as “clip”. Type one to keep it findable.
                </div>
              )}
              {compatible && include[i] && duplicated.has((names[i] ?? '').trim().toLowerCase()) && (
                <div className='mt-1 text-ui-sm text-warning'>
                  Another selected clip has this name — the second will be imported as “{(names[i] ?? '').trim()} (2)”.
                </div>
              )}
              {!compatible && (
                <div className='mt-1 text-ui-sm text-danger-fg'>
                  No source bone maps to the skeleton. Open <b>Skeleton</b> above and map at least the hips.
                </div>
              )}
            </div>
          )
        })}
      </div>

      <ModalFooter className='justify-between items-center'>
        <span className='text-ui-sm text-muted'>{chosen} selected</span>
        <div className='flex gap-2'>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant='success' className='font-semibold'
            disabled={chosen === 0} onClick={accept}>Add {chosen > 0 ? `${chosen} ` : ''}clip{chosen === 1 ? '' : 's'}</Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}
