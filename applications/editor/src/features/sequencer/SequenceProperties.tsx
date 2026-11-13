import { useMemo } from 'react'
import { compilePropertyPath, keyableProperties } from 'cleo'
import type { Node, PropertyTrack, SequenceData } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, Hint, Select, cn } from '@cleo/app-kit/ui'
import { formatTimecode } from '@cleo/app-kit/timeline'
import PropertyEditor from '../nodeInspector/propertyEditors/PropertyEditor'
import ScriptVariablesEditor from '../nodeInspector/scriptEditor/ScriptVariablesEditor'
import { isRootNode } from '../nodeInspector/useSelectedNode'
import { SequenceIcon } from '../sceneInspector/nodeIcons'
import { KEYING_ROOT_ATTR, namePathOf, useSequenceEditor, useSequenceRevision } from './SequenceEditorContext'
import { keyProperties } from './autoKey'
import * as E from './sequenceEdits'
import { AssetDropLockContext } from '../../utils/useAssetDrop'

// Properties in Sequencer mode: the same node inspector as Scene mode, under a strip that says changes are
// keys, with a Keys card for what the sequence already animates on the selected node. The whole panel is a
// keying root: a press or a focus inside it opens the interaction auto-key diffs (SequenceEditorContext).
//
// The inspector is re-mounted on the preview revision, so after a seek every editor reads the node at the
// playhead (preview writes raise no events, and many editors keep their own copy of what they show).

const KEY_EPS = 1e-4

/** The property tracks that drive `slotId`, with the section covering `t` (if any). */
function tracksOf(seq: SequenceData, slotId: string | undefined): PropertyTrack[] {
  if (!slotId) return []
  return seq.tracks.filter((t): t is PropertyTrack => t.type === 'property' && t.slot === slotId && !t.target)
}

/** Every key time of a property track, on the sequence's timeline. */
function keyTimes(track: PropertyTrack): number[] {
  const out: number[] = []
  for (const s of track.sections) for (const k of s.curve.keys) out.push(s.start + k.t)
  return out.sort((a, b) => a - b)
}

const show = (v: unknown): string => {
  if (typeof v === 'number') return (Math.round(v * 1000) / 1000).toString()
  if (Array.isArray(v)) return v.map(x => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)).join(', ')
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>, x => Math.round(x * 100) / 100).join(', ')
  return String(v)
}

function KeysCard({ node }: { node: Node }) {
  const ed = useSequenceEditor()
  const seq = ed.seq!
  const t = ed.preview.time
  const slotId = ed.slotOfNode(node)
  const tracks = tracksOf(seq, slotId)
  const pathTrack = slotId ? seq.tracks.find(tr => tr.type === 'path' && tr.slot === slotId) : undefined
  const keyable = useMemo(() => keyableProperties(node), [node, ed.preview.time]) // eslint-disable-line react-hooks/exhaustive-deps
  const animated = new Set(tracks.map(tr => tr.path))

  const seekTo = (to: number) => { ed.settleEdits(); ed.preview.pause(); ed.preview.seek(to) }

  const keyHere = (path: string) => {
    const p = keyable.find(k => k.path === path)
    if (!p) return
    const r = keyProperties(seq, { id: node.id, name: node.name, nodeType: node.nodeType, path: namePathOf(node, node.scene?.root ?? node) },
      [{ path, valueType: p.valueType, before: p.value, after: p.value }], ed.preview.timeRef.current, slotId)
    void ed.commit(`Key ${node.name} ${path}`, r.seq)
  }

  const deleteKeyHere = (track: PropertyTrack) => {
    const now = ed.preview.timeRef.current
    for (const s of track.sections) {
      const i = s.curve.keys.findIndex(k => Math.abs(s.start + k.t - now) < KEY_EPS)
      if (i < 0) continue
      // A track's last key takes the track with it: nothing would be left to animate.
      const next = s.curve.keys.length <= 1 && track.sections.length === 1
        ? E.deleteTrack(seq, track.id)
        : E.deleteSectionKey(seq, { trackId: track.id, sectionId: s.id }, i)
      void ed.commit(`Delete key ${track.path}`, next)
      return
    }
  }

  return (
    <Collapsable title='Keys' icon={<SequenceIcon />} persistKey='sequenceKeys'>
      <div className='flex flex-col gap-1 p-2'>
        {pathTrack && (
          <Hint>Position and rotation follow the <b>{pathTrack.name ?? 'Path'}</b> track: move its points in the Sequencer.</Hint>
        )}
        {tracks.length === 0 && !pathTrack && (
          <Hint>Nothing on {node.name} is animated yet. Change any of its properties below and it is keyed at the playhead.</Hint>
        )}
        {tracks.map(track => {
          const times = keyTimes(track)
          const here = times.some(k => Math.abs(k - t) < KEY_EPS)
          const prev = [...times].reverse().find(k => k < t - KEY_EPS)
          const next = times.find(k => k > t + KEY_EPS)
          const value = compilePropertyPath(node, track.path).get()
          return (
            <div key={track.id} className='flex items-center gap-1 text-ui-sm'>
              <span title={here ? 'A key at the playhead' : 'Animated: no key at the playhead'}
                className={cn('inline-block h-2.5 w-2.5 shrink-0 rotate-45 border border-sequence', here ? 'bg-sequence' : 'bg-transparent')} />
              <span className='min-w-0 flex-1 truncate text-fg' title={track.path}>{track.path}</span>
              <span className='max-w-[40%] truncate text-ui-xs text-muted tabular-nums' title={show(value)}>{show(value)}</span>
              <Button size='sm' variant='ghost' disabled={prev === undefined} title={prev !== undefined ? `Previous key (${formatTimecode(prev, seq.fps)})` : 'No earlier key'}
                onClick={() => prev !== undefined && seekTo(prev)}>‹</Button>
              <Button size='sm' variant='ghost' disabled={next === undefined} title={next !== undefined ? `Next key (${formatTimecode(next, seq.fps)})` : 'No later key'}
                onClick={() => next !== undefined && seekTo(next)}>›</Button>
              <Button size='sm' variant='remove' disabled={!here} title={here ? 'Delete the key at the playhead' : 'No key at the playhead'}
                onClick={() => deleteKeyHere(track)}>✕</Button>
            </div>
          )
        })}
        <Select value='' className='mt-1' title='Key the current value of a property, including ones no editor below shows'
          onChange={e => { if (e.target.value) keyHere(e.target.value) }}>
          <option value=''>Key property…</option>
          {keyable.map(p => (
            <option key={p.path} value={p.path}>{animated.has(p.path) ? `${p.path} (animated)` : p.path}</option>
          ))}
        </Select>
      </div>
    </Collapsable>
  )
}

export default function SequenceProperties({ node }: { node: Node | null }) {
  const ed = useSequenceEditor()
  const revision = useSequenceRevision()
  const seq = ed.seq
  return (
    <div {...{ [KEYING_ROOT_ATTR]: '' }} className='flex flex-col'>
      <div className='bg-sequence/20 px-2 py-1 text-ui-sm text-sequence'
        title='Sequencer mode keys changes instead of editing the scene: the scene tab still shows it as authored.'>
        Sequencer: changes are keyed at {formatTimecode(ed.preview.time, seq?.fps ?? 30)}
      </div>
      {node && seq && ed.host && !isRootNode(node) && !node.isEditorOwned && <KeysCard node={node} />}
      {node && isRootNode(node) && (
        <Hint className='p-2'>The scene's own settings are edited from the scene tab; Sequencer mode only keys nodes.</Hint>
      )}
      {node && !isRootNode(node) && (
        <AssetDropLockContext.Provider value>
          <PropertyEditor key={`${node.id}:${revision}`} node={node} readOnly={node.isEditorOwned} />
          {/* The script's fields (the Scripts panel, with its attach and detach, is not part of this mode). Never
              as a template override: what is changed here is keyed, then put back. */}
          <ScriptVariablesEditor key={`script:${node.id}:${revision}`} node={node} />
        </AssetDropLockContext.Provider>
      )}
    </div>
  )
}
