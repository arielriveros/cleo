import type { BoneMapping, BoneMatchKind } from 'cleo'
import type { RetargetBoneOption } from '../engineContextTypes'

// The source-bone → target-joint table, used by the RIG editor.
//
// It was written to be shared with the animation IMPORT modal, because the two are the same question
// asked at different moments: "which bone drives which" for a file being imported, and "which bone drives
// which" for every clip that will ever come from that source rig. Forking it lets the vocabulary — the
// kind chips, the unmapped-first ordering, the "— none —" sentinel — drift between the place a fix is
// made and the place it is kept.
//
// TODO: that fork already exists. `AnimationImportModal` still renders its own inlined copy of this
// table; point it here instead. The comment claimed the sharing before the second caller arrived.

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

/** Counts for the header, derived from the LIVE mapping so a fix updates them at once. */
export function mappingCounts(mapping: BoneMapping) {
  const mapped = mapping.entries.filter(e => e.targetNode !== null).length
  return {
    mapped,
    exact: mapping.entries.filter(e => e.kind === 'exact' || e.kind === 'normalized').length,
    auto: mapping.entries.filter(e => e.kind === 'humanoid' || e.kind === 'spine').length,
    manual: mapping.entries.filter(e => e.kind === 'manual').length,
    unmapped: mapping.entries.length - mapped,
    total: mapping.entries.length,
  }
}

export default function BoneMappingTable(props: {
  mapping: BoneMapping
  /** Every joint on the target skeleton — the dropdown's options. */
  targetBones: RetargetBoneOption[]
  /** Re-point one source bone. `null` drops its curve. */
  onRemap: (sourceNode: number, targetNode: number | null) => void
  className?: string
}) {
  // Unmapped first: those are the rows that need a decision, and a long skeleton buries them otherwise.
  const rows = [...props.mapping.entries]
    .sort((a, b) => (a.targetNode === null ? 0 : 1) - (b.targetNode === null ? 0 : 1))

  return (
    <div className={props.className}>
      {rows.map(e => (
        <div
          key={e.sourceNode}
          className='flex items-center gap-2 px-2 py-1 text-[11px] border-b border-control/50 last:border-0'
        >
          <span className='flex-1 truncate' title={e.sourceName ?? `node ${e.sourceNode}`}>
            {e.sourceName ?? `node ${e.sourceNode}`}
          </span>
          <span className={`px-1.5 py-0.5 rounded shrink-0 ${KIND_STYLE[e.kind]}`}>{KIND_LABEL[e.kind]}</span>
          <span className='text-dim shrink-0'>→</span>
          <select
            className='bg-control text-white border border-control-hover rounded px-1 py-0.5 w-[190px] shrink-0'
            value={e.targetNode ?? ''}
            onChange={ev => props.onRemap(e.sourceNode, ev.target.value === '' ? null : Number(ev.target.value))}
          >
            {/* Distinct from "not mapped yet": choosing it records a deliberate decision to drop the
                curve, which is why an override can store a null target. */}
            <option value=''>— none —</option>
            {props.targetBones.map(b => <option key={b.node} value={b.node}>{b.name}</option>)}
          </select>
        </div>
      ))}
      {!rows.length && (
        <div className='px-2 py-3 text-[11px] text-dim'>
          Nothing to map — no clip on this source rig animates a bone.
        </div>
      )}
    </div>
  )
}
