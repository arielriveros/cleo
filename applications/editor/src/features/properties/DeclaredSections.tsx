import React, { useEffect, useReducer } from 'react'
import {
  declarationOf, readProperty, resolveProperty, writeProperty,
  type Node, type PropertyDeclaration, type SectionDeclaration,
} from 'cleo'
import { PropertyRow, PropertyTable, Section } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../EngineContext'
import { BOX_VOLUME_EDITED } from '../gizmo/BoxVolumeGizmo'
import PropertyField from './PropertyField'

// A node's inspector rows, generated from what its class declares (src/properties): one row per property, each
// edited by its type through PropertyField, the editor a script's attribute of that type has too. A row's
// tooltip is its label's docs row. The card around the rows, and anything a type cannot say (presets, bake
// buttons, previews), stays the card's own.

/** What an editor reads a vector or colour as: a plain array (a node may hold a Float32Array). */
function fieldValue(value: unknown): unknown {
  return ArrayBuffer.isView(value) && !(value instanceof DataView) ? Array.from(value as unknown as ArrayLike<number>) : value
}

/** Re-render when the node may have changed behind the panel's back: an undo, a gizmo, a script. */
export function useNodeTick(node: Node): () => void {
  const { eventEmitter } = useCleoEngine()
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const onScene = () => bump()
    const onBox = (e: { nodeId?: string }) => { if (e?.nodeId === node.id) bump() }
    eventEmitter.on('SCENE_CHANGED', onScene)
    eventEmitter.on(BOX_VOLUME_EDITED, onBox)
    return () => { eventEmitter.off('SCENE_CHANGED', onScene); eventEmitter.off(BOX_VOLUME_EDITED, onBox) }
  }, [eventEmitter, node])
  return bump
}

function Rows(props: { node: Node; props: PropertyDeclaration[]; kind: string; bump: () => void }) {
  const { eventEmitter } = useCleoEngine()
  const shown = props.props.filter(p => !p.when || p.when(props.node))
  if (!shown.length) return null
  return (
    <PropertyTable columns={['45%', '55%']}>
      {shown.map(decl => {
        const p = resolveProperty(decl, props.node)
        return (
          <PropertyRow key={p.key} label={p.label} divider={!!p.divider}>
            <fieldset disabled={!!p.readonly} className='min-w-0 border-0 m-0 p-0'>
              <PropertyField type={p.type} node={props.node} value={fieldValue(readProperty(props.node, decl))}
                min={p.min} max={p.max} step={p.step} multiline={p.multiline} readout={p.readout}
                onChange={value => {
                  writeProperty(props.node, decl, value)
                  eventEmitter.emit('SCENE_CHANGED', { kind: props.kind, node: props.node })
                  props.bump()
                }} />
            </fieldset>
          </PropertyRow>
        )
      })}
    </PropertyTable>
  )
}

/**
 * One declared section of `node` by its title (`''`: the rows straight in the card), or nothing; `children`
 * follow its rows inside it (a card's own rows or buttons for that section). `keys` / `skip` show only some of its
 * rows, so a card can put a row of its own between them; `bare` leaves out the title (a section's second part).
 */
export function DeclaredSection(props: {
  node: Node; title: string; children?: React.ReactNode; keys?: readonly string[]; skip?: readonly string[]; bare?: boolean
}) {
  const bump = useNodeTick(props.node)
  const decl = declarationOf(props.node)
  const section = decl?.sections.find(s => s.title === props.title)
  if (!decl || !section || (section.when && !section.when(props.node))) return null
  const own = section.props.filter(p => (!props.keys || props.keys.includes(p.key)) && !props.skip?.includes(p.key))
  const rows = <><Rows node={props.node} props={own} kind={decl.kind} bump={bump} />{props.children}</>
  return section.title && !props.bare ? <Section title={section.title}>{rows}</Section> : rows
}

/** Every declared section of `node`, in order, but those in `except` (shown by the card itself). */
export default function DeclaredSections(props: { node: Node; except?: readonly string[] }) {
  const bump = useNodeTick(props.node)
  const decl = declarationOf(props.node)
  if (!decl) return null
  const sections = decl.sections.filter((s: SectionDeclaration) => !props.except?.includes(s.title) && (!s.when || s.when(props.node)))
  return (
    <>
      {sections.map(s => {
        const rows = <Rows key={s.title} node={props.node} props={s.props} kind={decl.kind} bump={bump} />
        return s.title ? <Section key={s.title} title={s.title}>{rows}</Section> : rows
      })}
    </>
  )
}
