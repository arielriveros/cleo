import { useEffect, useMemo, useState } from 'react'
import { applyManualMapping } from 'cleo'
import type { BoneMapping } from 'cleo'
import { useEditorSessions } from '../EditorSessionsContext'
import { Button, cn, DocScope, hintClass, Modal, ModalHeader, ModalFooter, SectionTitle, TextInput, Toggle } from '../../components/ui'
import RetargetMapper from '../rig/RetargetMapper'
import { retargetView } from '../../utils/retargetView'
// Shared with the model-import route: a placeholder clip name is renamed after its file in BOTH
// places, so the same download names its clip the same way whichever door it came in through.
import { clipNameFromFile } from '../../utils/clipNaming'

// Review modal for importing animation clips: a SKELETON mapping (which source bone drives which target
// joint) and the CLIP list. Clip counts are recomputed from the live mapping, so a mapping fix shows its
// effect before Accept, which is where EngineContext runs the retarget.

export default function AnimationImportModal() {
  // Raised from the editor root, outside every panel's docs scope: the import flow is documented here.
  return (
    <DocScope page='editor/models-and-materials' section='animation-import-and-retargeting'>
      <ImportReview />
    </DocScope>
  )
}

function ImportReview() {
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

  // What the retarget will do with every bone of the LIVE mapping: merged bones play too.
  const view = useMemo(
    () => (pendingAnimationImport && mapping ? retargetView(mapping, pendingAnimationImport.sourceSkin, pendingAnimationImport.targetSkin) : null),
    [pendingAnimationImport, mapping])

  if (!pendingAnimationImport || !mapping || !view) return null
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
  /** One bone back to what the automatic match chose for it. */
  const restoreAuto = (sourceNode: number) => setMapping(prev => {
    if (!prev) return prev
    const auto = info.mapping.entries.find(e => e.sourceNode === sourceNode)
    return { ...prev, entries: prev.entries.map(e => (e.sourceNode === sourceNode && auto ? { ...auto } : e)) }
  })

  // A bone PLAYS when the retarget will use its motion: mapped, or merged into a mapped bone below it.
  const plays = (n: number) => { const st = view.source.get(n); return st === 'auto' || st === 'manual' || st === 'merged' }
  /** Source bones in `nodes` whose motion the LIVE mapping loses, by name. */
  const lostNames = (nodes: number[]): string[] =>
    nodes.filter(n => !plays(n)).map(n => info.sourceBones.find(b => b.node === n)?.name ?? `node ${n}`)
  const c = view.counts

  return (
    <Modal onClose={cancel} className='w-[640px]'>
      <ModalHeader title='Import animation' doc='editor/models-and-materials#animation-import-and-retargeting'>
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
          <div className='rounded border border-control p-2 flex items-center gap-2'>
            <SectionTitle title='Skeleton' />
            {mapping.sameRig
              ? <span className='text-ui-sm text-success-fg flex-1'>same skeleton — no retargeting needed</span>
              : <span className='text-ui-sm text-muted flex-1'>
                  {c.mapped} mapped
                  {c.merged ? ` · ${c.merged} merged` : ''}
                  {c.lost ? <span className='text-danger-fg'> · {c.lost} lost</span> : ''}
                  {c.dropped ? ` · ${c.dropped} off` : ''}
                  {c.shared ? ` · ${c.shared} sharing` : ''}
                </span>}
            <Button size='sm' variant={c.lost ? 'primary' : 'subtle'} onClick={() => setShowMap(true)}
              title='See both skeletons side by side and drag bones from one to the other'>Map bones…</Button>
            {showMap && (
              <RetargetMapper
                sourceLabel={info.fileName}
                targetLabel={info.targetName}
                sourceSkin={info.sourceSkin}
                targetSkin={info.targetSkin}
                mapping={mapping}
                onRemap={remap}
                onAuto={restoreAuto}
                onResetAll={() => setMapping(info.mapping)}
                onClose={() => setShowMap(false)}
              />
            )}
          </div>
        )}

        {info.clips.map((clip, i) => {
          // Recount this clip's bones against the LIVE mapping, so a fix above updates the card at once.
          const animated = clip.animatedNodes.length
          const matched = clip.animatedNodes.filter(plays).length
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
                  title={`Imported as this name. Parsed from the file as "${clip.name}".`}
                />
                <span className={`text-ui-sm px-1.5 py-0.5 rounded ${compatible ? 'bg-success/15 text-success-fg' : 'bg-danger-surface text-danger-fg'}`}>
                  {compatible ? (mapping.sameRig ? '✓ compatible' : '✓ retargeted') : '✗ incompatible'}
                </span>
              </div>
              <div className='mt-1 text-ui-sm text-muted'>
                {matched}/{animated} bones mapped
              </div>
              {/* A lost bone's curve is DROPPED at commit and the target bone silently keeps its rest pose,
                  which reads as a limb rotated by a fixed amount rather than as a missing channel. Naming them
                  here is the difference between noticing that in the modal and chasing it in the viewport. */}
              {compatible && matched < animated && (
                <div className='mt-1 text-ui-sm text-warning' title={lostNames(clip.animatedNodes).join(', ')}>
                  {animated - matched} bone{animated - matched === 1 ? '' : 's'} not played (lost or turned off):{' '}
                  {lostNames(clip.animatedNodes).slice(0, 4).join(', ')}
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
                  No source bone maps to the skeleton. Press <b>Map bones…</b> above and map at least the hips.
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
