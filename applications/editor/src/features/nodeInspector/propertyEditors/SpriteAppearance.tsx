import { SpriteNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { Hint, PropertyRow, PropertyTable } from '@cleo/app-kit/ui'
import { AppearanceIcon } from '../sectionIcons'
import FollowLightRows from './FollowLightRows'
import { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'

// Tint, opacity, blending and the rest for any sprite (a static one, an animated one, a parallax layer): the
// Appearance rows SpriteNode declares (src/properties/sprites.ts), with the card's own pivot shortcuts and Follow
// Light (the lights near the sprite, by name). A sprite's image comes from its tileset, not a material.

const LIGHTING_HINT = {
  sixWay: 'Lit by the tileset\'s six-way lightmaps: the sun, its shadows and nearby lights relight it from their direction.',
  surface: 'Lit as a surface by the tileset\'s normal map (and ORM map): diffuse and highlights from the scene\'s lights.',
  flat: 'Lit flat: the tileset has no lighting maps (Tileset editor > Lighting maps), so it is shaded as a card facing the camera.',
} as const

const UP_TO_PIVOT = ['sprite.tint', 'sprite.opacity', 'sprite.blend', 'sprite.sortingOrder', 'sprite.pivot']
const UP_TO_EXPOSURE = ['sprite.flipX', 'sprite.flipY', 'sprite.lit', 'sprite.exposureWeight']

export default function SpriteAppearance(props: { node: SpriteNode }) {
  const eventEmitter = useEventBus()
  useNodeTick(props.node)
  const sprite = props.node.sprite
  const changed = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  const setPivot = (p: [number, number]) => { sprite.pivot = p; changed() }
  const part = (keys: readonly string[] | undefined, skip?: readonly string[]) =>
    <DeclaredSection node={props.node} of={SpriteNode} title='Appearance' bare keys={keys} skip={skip} />

  return (
    <Collapsable title='Appearance' icon={<AppearanceIcon />} persistKey='spriteAppearance'>
      <div className='w-full p-2'>
        {part(UP_TO_PIVOT)}
        <div className='flex justify-end gap-1 -mt-1 mb-1'>
          <button type='button' className='text-ui-sm text-muted hover:text-fg px-1' title='Pivot at the centre: 0.5, 0.5'
            onClick={() => setPivot([0.5, 0.5])}>Centre</button>
          <button type='button' className='text-ui-sm text-muted hover:text-fg px-1' title='Pivot at the bottom centre: 0.5, 0'
            onClick={() => setPivot([0.5, 0])}>Base</button>
        </div>
        {part(UP_TO_EXPOSURE)}
        <PropertyTable columns={['45%', '55%']}>
          <FollowLightRows node={props.node} target={sprite} onChange={changed} />
        </PropertyTable>
        {part(undefined, [...UP_TO_PIVOT, ...UP_TO_EXPOSURE])}
        {sprite.lit && (
          // How it is lit is the tileset's (Tileset editor > Lighting maps), so every sprite from it agrees.
          <Hint>{LIGHTING_HINT[props.node.tileset?.lighting ?? 'flat']}</Hint>
        )}
        {(props.node.tileset?.overdrive ?? 1) !== 1 && (
          // Read-only: overdrive belongs to the tileset (Tileset editor > Atlas), so every sprite from it agrees.
          <Hint>Overdrive ×{props.node.tileset!.overdrive} from the tileset: this sprite glows through bloom.</Hint>
        )}
      </div>
    </Collapsable>
  )
}
