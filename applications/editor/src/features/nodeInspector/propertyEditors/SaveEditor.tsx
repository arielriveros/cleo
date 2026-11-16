import { useEffect, useMemo, useState } from 'react'
import type { Node } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { PropertyTable, PropertyRow, Toggle } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import { SaveIcon } from '../sectionIcons'
import { parseScriptVariables, saveFieldNames } from '../../../utils/scripts'

// The node's part in the game's saves (SaveGame, src/core/save in the engine): the Saved flag, and what its
// script keeps of its own (`@save` fields, an onSave). The explanations are in docs/editor/node-inspector.md.

/** Whether a script's source implements onSave (as a method or an old-style handler). */
const definesOnSave = (source: string) => /\bonSave\s*(\(|=)/.test(source)

export default function SaveEditor(props: { node: Node; readOnly?: boolean }) {
  const { eventEmitter, scriptAssetOf } = useCleoEngine()
  const [saved, setSaved] = useState(props.node.saved)
  useEffect(() => { setSaved(props.node.saved) }, [props.node])

  const script = scriptAssetOf(props.node)
  // From the source, as the build reads it: an asset's stored schema is only as new as its last save.
  const fields = useMemo(() => saveFieldNames(script ? parseScriptVariables(script.source) : []), [script?.source])
  const custom = !!script && definesOnSave(script.source)

  const onSaved = (value: boolean) => {
    setSaved(value)
    props.node.saved = value
    eventEmitter.emit('SCENE_CHANGED')
  }

  return (
    <Collapsable title='Save' icon={<SaveIcon />} persistKey='save'>
      <div className='w-full p-2'>
        <PropertyTable columns={['28%', '72%']}>
          <PropertyRow label='Saved' divider={!!script}>
            <Toggle checked={saved} disabled={props.readOnly} onChange={onSaved} />
          </PropertyRow>
          {script &&
            <PropertyRow label='Saved fields' divider={false}>
              <span className='text-muted'>{fields.length ? fields.join(', ') : 'None'}</span>
            </PropertyRow>}
          {script && custom &&
            <PropertyRow label='Custom state' divider={false}>
              <span className='text-muted'>onSave / onRestore</span>
            </PropertyRow>}
        </PropertyTable>
      </div>
    </Collapsable>
  )
}
