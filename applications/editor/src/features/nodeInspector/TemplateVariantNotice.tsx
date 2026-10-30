import { useSelectedNode } from './useSelectedNode'
import { useVariantBase } from './useVariantBase'
import { useEditorSessions } from '../EditorSessionsContext'
import { useCleoEngine } from '../EngineContext'
import { Button, Select } from '@cleo/app-kit/ui'
import { hasOwnChanges, lineageOf } from '../../utils/templateVariants'

// Above the inspector in a variant's tab: what the variant is based on, whether the selected node is
// inherited from it (its untouched values follow the base) or added by the variant, and the way back to
// the base — for that node's values, or for the whole variant.
export default function TemplateVariantNotice() {
  const { editingTemplateVariant, revertVariantChanges, rebaseTemplateVariant } = useEditorSessions()
  const { templates } = useCleoEngine()
  const { node } = useSelectedNode()
  const origin = useVariantBase(node)
  if (!editingTemplateVariant) return null
  const { diff, baseName, base, id } = editingTemplateVariant
  // Any template but this one and those based on it (that would be a cycle).
  const excluded = lineageOf(templates, id)
  const bases = templates.filter(t => !excluded.has(t.id)).sort((a, b) => a.name.localeCompare(b.name))
  const nodeChanged = !!origin && origin.baseNode !== 'added' && hasOwnChanges(diff, origin.path)
  const anyChanged = Object.keys(diff.nodes).some(p => hasOwnChanges(diff, p))
    || Object.keys(diff.bodies).length + Object.keys(diff.triggers).length + Object.keys(diff.scripts).length > 0
  return (
    <div className='bg-primary/10'>
    <div className='text-ui-sm text-primary px-2 py-1 flex items-start gap-2'>
      <span className='flex-1'>
        Variant of <b>{baseName}</b>. Saved as its differences: values left untouched follow the base when
        it changes.
        {origin && (origin.baseNode === 'added'
          ? <span className='text-dim'> This node is added by the variant.</span>
          : <span className='text-dim'> This node is inherited{nodeChanged ? ' and changed here' : ''}.</span>)}
      </span>
      {nodeChanged &&
        <Button variant='link' size='sm' className='shrink-0'
          title={`Drop this node's changes (any value, its collider, its script) and take ${baseName}'s. Saves first.`}
          onClick={() => void revertVariantChanges(origin!.path)}>
          Revert node
        </Button>}
      {anyChanged &&
        <Button variant='link' size='sm' className='shrink-0'
          title={`Drop every value the variant changed and take ${baseName}'s. Added and removed nodes stay. Saves first.`}
          onClick={() => void revertVariantChanges()}>
          Revert all
        </Button>}
    </div>
    <label className='flex items-center gap-2 px-2 pb-1 text-ui-sm text-dim'
      title='Base this variant on another template. What it looks like now is kept; from then on it follows the new base. Saves first.'>
      Based on
      <Select className='flex-1' value={base.id} onChange={e => { if (e.target.value !== base.id) void rebaseTemplateVariant(e.target.value) }}>
        {!bases.some(t => t.id === base.id) && <option value={base.id}>{baseName}</option>}
        {bases.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
    </label>
    </div>
  )
}
