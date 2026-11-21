import { Camera2DNode, Room2DNode, ParallaxLayerNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { DocScope, Hint } from '@cleo/app-kit/ui'
import { CameraIcon, SpriteIcon } from '../sectionIcons'
import SpriteEditor from './SpriteEditor'
import DeclaredSections from '../../properties/DeclaredSections'

// The inspectors of the 2D nodes: the 2D game camera, a room of a 2D world, and a parallax backdrop. Their rows
// are the nodes' declared properties (src/properties/twoD.ts), documented with the rest of 2D
// (docs/editor/tilemap-2d.md).

export function Camera2DEditor(props: { node: Camera2DNode }) {
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Camera 2D' icon={<CameraIcon />} persistKey='node.camera2D' defaultOpen>
        <div className='w-full p-2'>
          <DeclaredSections node={props.node} of={Camera2DNode} />
          <Hint className='mt-1'>It takes over in Play. The editor's view stays your own; the frame drawn here is the reference resolution.</Hint>
        </div>
      </Collapsable>
    </DocScope>
  )
}

export function Room2DEditor(props: { node: Room2DNode }) {
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Room' icon={<CameraIcon />} persistKey='node.room2D' defaultOpen>
        <div className='w-full p-2'>
          <DeclaredSections node={props.node} of={Room2DNode} />
        </div>
      </Collapsable>
    </DocScope>
  )
}

export function ParallaxLayerEditor(props: { node: ParallaxLayerNode }) {
  return (
    <>
      <DocScope page='editor/tilemap-2d'>
        <Collapsable title='Parallax Layer' icon={<SpriteIcon />} persistKey='node.parallaxLayer' defaultOpen>
          <div className='w-full p-2'>
            <DeclaredSections node={props.node} of={ParallaxLayerNode} />
            <Hint className='mt-1'>Repeats when its tileset is the one image (a background imported as its own tileset).</Hint>
          </div>
        </Collapsable>
      </DocScope>
      <SpriteEditor node={props.node} />
    </>
  )
}
