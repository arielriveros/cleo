import { useState } from 'react'
import { TilemapNode } from 'cleo'
import type { GridKind, HexOffset, HexOrientation } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { Hint, NumberInput, Select, Toggle } from '../../../components/ui'
import { useCleoEngine } from '../../EngineContext'

// Node inspector for a TilemapNode: the grid layout every cell coordinate is interpreted through, plus the
// two map-wide settings that are not per-layer (which layer sprites sort against, and how deep colliders are).

const label = 'text-xs text-gray-300'

export default function TilemapEditor(props: { node: TilemapNode }) {
  const { eventEmitter } = useCleoEngine()
  const [, force] = useState(0)
  const tilemap = props.node.tilemap
  const grid = tilemap.grid

  const commit = () => { eventEmitter.emit('SCENE_CHANGED'); force(x => x + 1) }
  const setGrid = (patch: Partial<typeof grid>) => { tilemap.setGrid({ ...grid, ...patch }); commit() }

  return (
    <Collapsable title='Tilemap' persistKey='node.tilemap' defaultOpen>
      <div className='p-2 space-y-2'>
        <div className='flex items-center justify-between'>
          <span className={label} title='How a cell coordinate is laid out. Isometric here is a screen-space diamond on the XY plane, not a 3D projection.'>Grid</span>
          <Select
            className='w-28 text-xs'
            value={grid.kind}
            onChange={(e) => setGrid({ kind: e.target.value as GridKind })}
          >
            <option value='orthogonal'>Orthogonal</option>
            <option value='isometric'>Isometric</option>
            <option value='hexagonal'>Hexagonal</option>
          </Select>
        </div>

        <div className='flex items-center justify-between'>
          <span className={label} title='World size of one cell’s bounding box'>Cell size</span>
          <span className='flex gap-1'>
            <NumberInput className='w-14' value={grid.cellWidth} step={0.1} min={0.01}
              onChange={(v) => setGrid({ cellWidth: Math.max(0.01, v) })} />
            <NumberInput className='w-14' value={grid.cellHeight} step={0.1} min={0.01}
              onChange={(v) => setGrid({ cellHeight: Math.max(0.01, v) })} />
          </span>
        </div>

        {grid.kind === 'hexagonal' && (
          <>
            <div className='flex items-center justify-between'>
              <span className={label}>Orientation</span>
              <Select
                className='w-28 text-xs'
                value={grid.hexOrientation}
                onChange={(e) => setGrid({ hexOrientation: e.target.value as HexOrientation })}
              >
                <option value='pointy'>Pointy top</option>
                <option value='flat'>Flat top</option>
              </Select>
            </div>
            <div className='flex items-center justify-between'>
              <span className={label} title='Which line gets the half-cell shove'>Offset</span>
              <Select
                className='w-28 text-xs'
                value={grid.hexOffset}
                onChange={(e) => setGrid({ hexOffset: e.target.value as HexOffset })}
              >
                {grid.hexOrientation === 'pointy'
                  ? <><option value='odd-r'>Odd rows</option><option value='even-r'>Even rows</option></>
                  : <><option value='odd-q'>Odd columns</option><option value='even-q'>Even columns</option></>}
              </Select>
            </div>
            <div className='flex items-center justify-between'>
              <span className={label} title='Length of the hexagon’s two axis-aligned sides'>Side length</span>
              <NumberInput className='w-16' value={grid.hexSideLength} step={0.05} min={0.01}
                onChange={(v) => setGrid({ hexSideLength: Math.max(0.01, v) })} />
            </div>
          </>
        )}

        <div className='flex items-center justify-between pt-1'>
          <span className={label} title='Sprites join this layer’s draw band when they depth-sort'>Entity layer</span>
          <Select
            className='w-28 text-xs'
            value={tilemap.entityLayer}
            onChange={(e) => { tilemap.entityLayer = Number(e.target.value); commit() }}
          >
            {tilemap.layers.map((l, i) => <option key={i} value={i}>{l.cfg.name}</option>)}
          </Select>
        </div>

        <div className='flex items-center justify-between'>
          <span className={label} title='Half-depth along Z given to generated colliders. Only square grids merge their solid cells into large collider boxes; isometric and hexagonal maps emit one convex prism per solid cell.'>Collision depth</span>
          <NumberInput className='w-16' value={tilemap.collisionDepth} step={0.1} min={0.01}
            onChange={(v) => { tilemap.collisionDepth = Math.max(0.01, v); commit() }} />
        </div>

        <div className='flex items-center justify-between pt-1'>
          <span className={label}>Layers</span>
          <span className='text-[11px] text-muted'>{tilemap.layers.length}</span>
        </div>
        <Hint>Paint and manage layers in Tilemap mode.</Hint>
      </div>
    </Collapsable>
  )
}
