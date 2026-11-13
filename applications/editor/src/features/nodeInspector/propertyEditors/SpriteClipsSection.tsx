import { useEffect, useState } from 'react'
import { AnimatedSpriteNode, clipLength } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Hint, PropertyRow, PropertyTable, Select, Toggle } from '@cleo/app-kit/ui'
import { FramesIcon } from '../sectionIcons'

// The Clips section of an animated sprite that carries an animation set: its clips and machine states, what
// is playing, and a preview of any clip in the viewport (an editing scene runs, so the sprite plays it).

export default function SpriteClipsSection(props: { node: AnimatedSpriteNode }) {
  const n = props.node
  const set = n.animationSet
  const [, tick] = useState(0)
  // What plays changes every frame; a slow poll keeps the readout honest without re-rendering per frame.
  useEffect(() => {
    const id = window.setInterval(() => tick(x => x + 1), 250)
    return () => window.clearInterval(id)
  }, [n])
  if (!set) return null

  return (
    <Collapsable title='Clips' icon={<FramesIcon />} persistKey='animatedSprite.clips' defaultOpen>
      <div className='w-full p-2'>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Playing' hint='The clip on screen, and the machine state that chose it.'>
            <span className='text-ui-sm tabular-nums'>{n.clip ?? '—'}{n.state ? ` (${n.state})` : ''} · frame {n.clipFrame + 1}</span>
          </PropertyRow>
          <PropertyRow label='Preview' hint='Play a clip in the viewport. The machine takes over again from its entry state.'>
            <Select value={n.clip ?? ''} onChange={(e) => n.play(e.target.value, true)}>
              {set.clips.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </Select>
          </PropertyRow>
          {set.machine && (
            <PropertyRow label='Machine'>
              <Toggle checked={n.state !== null} onChange={(c) => { if (c) n.resumeMachine(); else n.play(n.clip ?? set.defaultClip, true) }} />
            </PropertyRow>
          )}
        </PropertyTable>
        <div className='mt-2 space-y-0.5'>
          {set.clips.map(c => (
            <div key={c.name} className='flex items-center justify-between text-ui-sm'>
              <span>{c.name}</span>
              <span className='text-muted tabular-nums'>{c.frames.length} frames · {clipLength(c).toFixed(2)} s · {c.loop}</span>
            </div>
          ))}
        </div>
        {set.machine && (
          <Hint className='mt-1'>{set.machine.states.length} states, {set.machine.transitions.length} transitions; entry {set.machine.entry}.</Hint>
        )}
      </div>
    </Collapsable>
  )
}
