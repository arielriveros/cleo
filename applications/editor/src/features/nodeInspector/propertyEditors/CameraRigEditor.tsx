import { CameraRigNode, CAMERA_RIG_PRESETS, type CameraRigPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { Button, PresetMenu } from '@cleo/app-kit/ui'
import { RigIcon } from '../sectionIcons'
import { DeclaredSection } from '../../properties/DeclaredSections'

// The Camera Rig inspector: the rig's declared properties (src/properties/cameras.ts), section by section, with
// its presets and a Test Shake.

const SECTIONS = ['Follow (drives position)', 'Aim (drives rotation)', 'Spring Arm', 'Field of View', 'Collision'] as const

export default function CameraRigEditor(props: { node: CameraRigNode }) {
  const { eventEmitter } = useCleoEngine()
  const applyPreset = (p: CameraRigPreset) => {
    props.node.applyPreset(p)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }
  return (
    <Collapsable title='Camera Rig' icon={<RigIcon />} persistKey='cameraRig'
      right={<PresetMenu presets={CAMERA_RIG_PRESETS} onApply={applyPreset} title='Camera styles — targets, sensitivity and shake stay yours' />}>
      <div className='w-full p-2'>
        {SECTIONS.map(title => <DeclaredSection key={title} node={props.node} title={title} />)}
        <DeclaredSection node={props.node} title='Shake'>
          <Button className='mt-1' onClick={() => props.node.shake(0.6)}>Test Shake</Button>
        </DeclaredSection>
      </div>
    </Collapsable>
  )
}
