import { TilemapNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { TilemapIcon } from '../../sceneInspector/nodeIcons'
import { DocScope, PropertyRow, PropertyTable, Select } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../../EngineContext'
import DeclaredSections, { useNodeTick } from '../../properties/DeclaredSections'

// Node inspector for a TilemapNode: the grid layout every cell coordinate is interpreted through, plus the
// map-wide settings that are not per-layer. Its rows are the tilemap's declared properties
// (src/properties/sprites.ts); the entity layer, picked from the map's own layers, is the card's.

export default function TilemapEditor(props: { node: TilemapNode }) {
  const { eventEmitter } = useCleoEngine()
  useNodeTick(props.node)
  const tilemap = props.node.tilemap

  return (
    <DocScope page='editor/tilemap-2d'>
    <Collapsable title='Tilemap' icon={<TilemapIcon />} persistKey='node.tilemap' defaultOpen>
      <div className='w-full p-2'>
        <DeclaredSections node={props.node} />
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Entity layer'>
            <Select value={tilemap.entityLayer}
              onChange={(e) => { tilemap.entityLayer = Number(e.target.value); eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node }) }}>
              {tilemap.layers.map((l, i) => <option key={i} value={i}>{l.cfg.name}</option>)}
            </Select>
          </PropertyRow>
          <PropertyRow label='Layers' divider={false}>
            <span className='text-ui-sm text-muted'>{tilemap.layers.length}</span>
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
    </DocScope>
  )
}
