import { WindNode, WIND_PRESETS, WIND_REFERENCE_SPEED, type WindPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { useDebugVisibility } from '../../DebugVisibilityContext'
import { PresetMenu, PropertyTable, PropertyRow, Toggle } from '@cleo/app-kit/ui'
import { WindIcon } from '../../sceneInspector/nodeIcons'
import DeclaredSections, { useNodeTick } from '../../properties/DeclaredSections'

// The Wind inspector: the wind's declared properties (src/properties/environment.ts), the editor's own Show
// field switch, and a line reading the air the settings make.

export default function WindEditor(props: { node: WindNode }) {
  const eventEmitter = useEventBus()
  const { visibility, setCategory } = useDebugVisibility()
  useNodeTick(props.node)   // the air line follows the rows

  const applyPreset = (p: WindPreset) => {
    props.node.applyPreset(p)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }

  // The air between gusts and at their crest (gustiness takes the lull down from the crest).
  const crest = props.node.strength * WIND_REFERENCE_SPEED
  const lull = crest * (1 - props.node.gustiness)
  const air = crest < 0.05 ? 'Still air' : `Air ${lull.toFixed(1)} m/s between gusts, ${crest.toFixed(1)} at their crest`

  return (
    <Collapsable title='Wind' icon={<WindIcon />} persistKey='wind'
      right={<PresetMenu presets={WIND_PRESETS} onApply={applyPreset} title='Wind presets — strength, gusts and veer; the direction stays yours' />}>
      <div className='w-full p-2'>
        <DeclaredSections node={props.node} />
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Show field' divider={false}>
            <Toggle checked={visibility.windField.editor} onChange={on => setCategory('windField', 'editor', on)} />
          </PropertyRow>
        </PropertyTable>
        <p className='text-ui-sm text-muted mt-1'>{air}</p>
      </div>
    </Collapsable>
  )
}
