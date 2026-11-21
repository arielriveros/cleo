import { useEffect, useRef, useState } from 'react'
import { CharacterNode, CHARACTER_PRESETS, type CharacterPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { DocScope, PresetMenu, SectionTitle, cn, labelClass } from '@cleo/app-kit/ui'
import { CharacterIcon } from '../sectionIcons'
import DeclaredSections from '../../properties/DeclaredSections'

// The Character inspector: its declared tuning (src/properties/gameplay.ts), documented with the tuning it sets
// (docs/scripting/characters-and-controllers.md, Character tuning). The presets and the live Animator outputs
// are the card's own.

export default function CharacterEditor(props: { node: CharacterNode }) {
  const { eventEmitter, isPlayMode } = useCleoEngine()

  const applyPreset = (p: CharacterPreset) => {
    props.node.applyPreset(p)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  return (
    <Collapsable title='Character' icon={<CharacterIcon />} persistKey='character'
      right={<PresetMenu presets={CHARACTER_PRESETS} onApply={applyPreset} title='Movement feels — speeds change what the locomotion clips cover' />}>
      {/* The title is a node-inspector entry; its groups are described with the tuning they set. */}
      <DocScope page='scripting/characters-and-controllers' section='character-tuning'>
        <div className='w-full p-2'>
          <DeclaredSections node={props.node} />

          <SectionTitle title='Animator outputs' className='mt-3 mb-1' />
          <AnimatorOutputs node={props.node} live={isPlayMode} />
        </div>
      </DocScope>
    </Collapsable>
  )
}

/**
 * The three values this character publishes to its Animator.
 *
 * Polled on rAF while playing, because that is the only way to see whether a blend space is reading what
 * you think it is: `moveDir` is an angle whose SIGN is the thing that goes wrong, and a mirrored strafe
 * looks almost right until you watch the number.
 */
function AnimatorOutputs({ node, live }: { node: CharacterNode; live: boolean }) {
  const [values, setValues] = useState({ moveDir: 0, isJumping: false, turnRequest: 0 })
  const frame = useRef(0)

  useEffect(() => {
    if (!live) return
    const tick = () => {
      setValues({ moveDir: node.moveDir, isJumping: node.isJumping, turnRequest: node.turnRequest })
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [node, live])

  const row = (name: string, value: string, note: string) => (
    <div className='flex items-center gap-2 text-ui-sm font-mono'>
      <span className={cn(labelClass, 'w-[92px]')}>{name}</span>
      <span className='w-16 tabular-nums text-fg'>{value}</span>
      <span className='text-muted'>{note}</span>
    </div>
  )

  return (
    <div className='flex flex-col gap-0.5'>
      {row('moveDir', live ? values.moveDir.toFixed(1) : '—', '0 ahead · -90 right · +90 left')}
      {row('turnRequest', live ? String(values.turnRequest) : '—', '±1 / ±2, + is right')}
      {row('isJumping', live ? String(values.isJumping) : '—', 'take-off until landed')}
      {!live && <p className='text-ui-sm text-muted mt-1'>Press Play to watch these update.</p>}
    </div>
  )
}
