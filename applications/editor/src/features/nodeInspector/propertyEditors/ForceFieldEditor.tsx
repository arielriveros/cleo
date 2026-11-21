import { ForceFieldNode, FORCE_FIELD_PRESETS, type ForceFieldPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { PresetMenu } from '@cleo/app-kit/ui'
import { ForceFieldIcon } from '../sectionIcons'
import { useEventBus } from '../../EventBusContext'
import DeclaredSections from '../../properties/DeclaredSections'

// The Force Field inspector: the field's declared properties (src/properties/effects.ts). Direction (wind) and
// axis (vortex) are the node's local +Y, so they are set by rotating the node — the gizmo is the direction
// control, and there is deliberately no vector here. "Affects wind" makes the field local WIND as well
// (core/wind/windField.ts): foliage bends to it and Scene-wind particles ride it.

export default function ForceFieldEditor(props: { node: ForceFieldNode }) {
  const eventEmitter = useEventBus()
  const applyPreset = (p: ForceFieldPreset) => {
    props.node.applyPreset(p)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }
  return (
    <Collapsable title='Force Field' icon={<ForceFieldIcon />} persistKey='forceFieldEditor'
      right={<PresetMenu presets={FORCE_FIELD_PRESETS} onApply={applyPreset} title='Force presets — kind, shape and strength (the Wind ones move the air); size and aim stay yours' />}>
      <div className='w-full p-2'>
        <DeclaredSections node={props.node} />
      </div>
    </Collapsable>
  )
}
