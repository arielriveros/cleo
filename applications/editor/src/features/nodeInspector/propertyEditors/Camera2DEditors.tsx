import { useEffect, useState } from 'react'
import { Camera2DNode, Room2DNode, ParallaxLayerNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { DocScope, NumberInput, PropertyRow, PropertyTable, TextInput, Toggle, Hint } from '@cleo/app-kit/ui'
import { useEventBus } from '../../EventBusContext'
import { CameraIcon, SpriteIcon } from '../sectionIcons'
import SpriteEditor from './SpriteEditor'

// The inspectors of the 2D nodes: the 2D game camera, a room of a 2D world, and a parallax backdrop. All
// three are documented with the rest of 2D (docs/editor/tilemap-2d.md).

/** Two numbers side by side, for a pair field (a size, an offset). */
function PairInput(props: { value: [number, number], step?: number, min?: number, onChange: (v: [number, number]) => void }) {
  const clamp = (v: number) => (props.min !== undefined ? Math.max(props.min, v) : v)
  return (
    <span className='flex gap-1'>
      <NumberInput className='w-16' step={props.step ?? 0.1} value={props.value[0]}
        onChange={(v) => props.onChange([clamp(v), props.value[1]])} />
      <NumberInput className='w-16' step={props.step ?? 0.1} value={props.value[1]}
        onChange={(v) => props.onChange([props.value[0], clamp(v)])} />
    </span>
  )
}

/** Re-render on a node edit the panel made itself: node fields are not React state. */
function useNodeEdit(node: unknown): [() => void, number] {
  const eventEmitter = useEventBus()
  const [version, setVersion] = useState(0)
  useEffect(() => { setVersion(v => v + 1) }, [node])
  const changed = () => {
    setVersion(v => v + 1)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
  }
  return [changed, version]
}

export function Camera2DEditor(props: { node: Camera2DNode }) {
  const n = props.node
  const [changed] = useNodeEdit(n)
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Camera 2D' icon={<CameraIcon />} persistKey='node.camera2D' defaultOpen>
        <div className='w-full p-2'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Active'>
              <Toggle checked={n.active} onChange={(c) => { n.active = c; changed() }} />
            </PropertyRow>
            <PropertyRow label='Pixels per unit' hint='Art pixels in a world unit: match the tilesets’ (a 16 px tile at 16 is one unit).'>
              <NumberInput step={1} value={n.pixelsPerUnit} onChange={(v) => { n.pixelsPerUnit = Math.max(1, v); changed() }} />
            </PropertyRow>
            <PropertyRow label='Reference resolution' hint='The view in art pixels, at least, at zoom 1.'>
              <PairInput step={1} min={1} value={n.referenceResolution} onChange={(v) => { n.referenceResolution = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Zoom'>
              <NumberInput step={0.25} value={n.zoom} onChange={(v) => { n.zoom = Math.max(0.05, v); changed() }} />
            </PropertyRow>
            <PropertyRow label='Pixel perfect' hint='Whole screen pixels per art pixel: drawn at art resolution and scaled up unfiltered.'>
              <Toggle checked={n.pixelPerfect} onChange={(c) => { n.pixelPerfect = c; changed() }} />
            </PropertyRow>
            <PropertyRow label='Follow' hint='The name of the node the camera follows. Empty: it stays where it is placed.'>
              <TextInput value={n.followTarget} placeholder='Player' onChange={(v) => { n.followTarget = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Follow offset'>
              <PairInput value={n.followOffset} onChange={(v) => { n.followOffset = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Dead zone' hint='The box round the view’s centre the target moves in before the camera does, world units.'>
              <PairInput min={0} value={n.deadzone} onChange={(v) => { n.deadzone = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Damping' hint='About how long the camera takes to catch up, seconds. 0 locks it on.'>
              <NumberInput step={0.02} value={n.damping} onChange={(v) => { n.damping = Math.max(0, v); changed() }} />
            </PropertyRow>
            <PropertyRow label='Look ahead' hint='How far ahead of a moving target the camera looks, world units.'>
              <NumberInput step={0.25} value={n.lookAhead} onChange={(v) => { n.lookAhead = Math.max(0, v); changed() }} />
            </PropertyRow>
            <PropertyRow label='Confine to rooms' hint='Keep the view inside the Room the target stands in.'>
              <Toggle checked={n.confineToRooms} onChange={(c) => { n.confineToRooms = c; changed() }} />
            </PropertyRow>
            <PropertyRow label='Room transition' hint='How long the slide into the next room takes, seconds. 0 cuts.'>
              <NumberInput step={0.05} value={n.roomTransitionSeconds} onChange={(v) => { n.roomTransitionSeconds = Math.max(0, v); changed() }} />
            </PropertyRow>
          </PropertyTable>
          <Hint className='mt-1'>It takes over in Play. The editor's view stays your own; the frame drawn here is the reference resolution.</Hint>
        </div>
      </Collapsable>
    </DocScope>
  )
}

export function Room2DEditor(props: { node: Room2DNode }) {
  const n = props.node
  const [changed] = useNodeEdit(n)
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Room' icon={<CameraIcon />} persistKey='node.room2D' defaultOpen>
        <div className='w-full p-2'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Size' hint='Width and height, world units, centred on the node.'>
              <PairInput min={0} step={1} value={n.size} onChange={(v) => { n.size = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Zone' hint='A free label for the area the room belongs to: for a map, an ambience or a script.'>
              <TextInput value={n.zone} onChange={(v) => { n.zone = v; changed() }} />
            </PropertyRow>
          </PropertyTable>
        </div>
      </Collapsable>
    </DocScope>
  )
}

export function ParallaxLayerEditor(props: { node: ParallaxLayerNode }) {
  const n = props.node
  const [changed] = useNodeEdit(n)
  return (
    <>
      <DocScope page='editor/tilemap-2d'>
        <Collapsable title='Parallax Layer' icon={<SpriteIcon />} persistKey='node.parallaxLayer' defaultOpen>
          <div className='w-full p-2'>
            <PropertyTable columns={['45%', '55%']}>
              <PropertyRow label='Parallax' hint='How much of the camera’s travel the layer moves with: 1 with the world, 0 not at all (a sky).'>
                <PairInput step={0.05} value={n.parallax} onChange={(v) => { n.parallax = v; changed() }} />
              </PropertyRow>
              <PropertyRow label='Repeat X'>
                <Toggle checked={n.repeatX} onChange={(c) => { n.repeatX = c; changed() }} />
              </PropertyRow>
              <PropertyRow label='Repeat Y'>
                <Toggle checked={n.repeatY} onChange={(c) => { n.repeatY = c; changed() }} />
              </PropertyRow>
              <PropertyRow label='Scroll' hint='A drift of its own, world units a second (clouds).'>
                <PairInput step={0.1} value={n.scroll} onChange={(v) => { n.scroll = v; changed() }} />
              </PropertyRow>
            </PropertyTable>
            <Hint className='mt-1'>Repeats when its tileset is the one image (a background imported as its own tileset).</Hint>
          </div>
        </Collapsable>
      </DocScope>
      <SpriteEditor node={n} />
    </>
  )
}
