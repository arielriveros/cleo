import { useEffect, useMemo, useState } from 'react'
import type { Node } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { PropertyTable, PropertyRow, Toggle } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { NetSyncIcon } from '../sectionIcons'

// The node's part in online play (NetSync, docs/design/netsync.md): whether the host sends it to its players, and
// why. A node that is not synced is seen by every player as the level placed it, which is right for walls and
// wrong for anything that moves: the section says which this is, so nothing fails to sync silently. The
// explanations are in docs/editor/node-inspector.md. Shown while Project ▸ NetSync ▸ Online play is on.

/** The `@synced` fields and `@netcall` methods a script declares, read from its source (for display). */
export function netsyncMembers(source: string): { synced: string[]; netcalls: string[] } {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const call = String.raw`(?:\((?:[^()]|\([^()]*\))*\))?`
  const synced = [...code.matchAll(new RegExp(String.raw`@synced${call}\s+(?:(?:public|private|protected|readonly|declare)\s+)*([A-Za-z_$][\w$]*)`, 'g'))].map(m => m[1])
  const netcalls = [...code.matchAll(new RegExp(String.raw`@netcall${call}\s+(?:(?:public|private|protected|async)\s+)*([A-Za-z_$][\w$]*)\s*\(`, 'g'))].map(m => m[1])
  return { synced: [...new Set(synced)], netcalls: [...new Set(netcalls)] }
}

/** Why the host syncs this node without being asked, or null: it would not. */
function syncedBecause(node: Node, members: { synced: string[]; netcalls: string[] }): string | null {
  if (node.nodeType === 'character') return 'a Character'
  if (node.nodeType === 'collider' && ((node as any).mass ?? 0) > 0) return 'a Collider with mass'
  if (members.synced.length || members.netcalls.length) return 'its script syncs fields or has netcalls'
  return null
}

export default function NetSyncEditor(props: { node: Node; readOnly?: boolean }) {
  const { eventEmitter, scriptAssetOf } = useCleoEngine()
  const read = () => { const v = props.node.getVariable('netSync'); return v === true || v === 1 || v === 'true' }
  const [flag, setFlag] = useState(read)
  useEffect(() => { setFlag(read()) }, [props.node])

  const script = scriptAssetOf(props.node)
  const members = useMemo(() => netsyncMembers(script?.source ?? ''), [script?.source])
  const because = syncedBecause(props.node, members)

  const onFlag = (value: boolean) => {
    setFlag(value)
    if (value) props.node.setVariable('netSync', true, 'boolean')
    else props.node.removeVariable('netSync')
    eventEmitter.emit('SCENE_CHANGED')
  }

  return (
    <Collapsable title='NetSync' icon={<NetSyncIcon />} persistKey='netsync'>
      <div className='w-full p-2'>
        <PropertyTable columns={['28%', '72%']}>
          <PropertyRow label='Synced' divider={false}>
            {because
              ? <span className='text-muted'>Yes: {because}</span>
              : <Toggle checked={flag} disabled={props.readOnly} onChange={onFlag} />}
          </PropertyRow>
          {!because && !flag &&
            <PropertyRow label='' divider={false}>
              <span className='text-ui-sm text-dim'>Not synced: every player sees it as the level placed it. Turn this on for anything that moves on the host.</span>
            </PropertyRow>}
          {script &&
            <PropertyRow label='Synced fields' divider={false}>
              <span className='text-muted'>{members.synced.length ? members.synced.join(', ') : 'None'}</span>
            </PropertyRow>}
          {script && members.netcalls.length > 0 &&
            <PropertyRow label='Netcalls' divider={false}>
              <span className='text-muted'>{members.netcalls.join(', ')}</span>
            </PropertyRow>}
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
