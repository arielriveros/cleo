import { useEffect, useState } from 'react'
import { NavMeshNode, bakeNavMesh } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import {
  Button, DocScope, PropertyRow, PropertyTable, Slider, Toggle, cn,
} from '@cleo/app-kit/ui'
import { gatherNavSoup } from '../../../utils/navBakeSources'
import { navPreviewSkippedFor } from '../../../utils/editorHelpers'
import { NavMeshIcon } from '../../sceneInspector/nodeIcons'
import { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'

// Every row's explanation is its row in docs/editor/ai-agents.md › Navigation meshes, shown as the
// label's hover card; only the live status lines below carry their own tooltips.

/** How the bake samples terrain: the card's own, not saved with the node. */
interface TerrainSampling {
  includeTerrain: boolean
  terrainStep: number
}

/** What the last bake produced, so an author can see whether it found anything at all. */
interface BakeReport {
  regions: number
  walkable: number
  rejected: number
  colliders: number
  terrains: number
  obstacles: number
  ms: number
  /** Whether the bake was restricted to the node's box, so the report can say what it covered. */
  bounded: boolean
}

export default function NavMeshEditor(props: { node: NavMeshNode }) {
  const { eventEmitter, editorScene } = useCleoEngine()
  useNodeTick(props.node)
  const [state, setState] = useState<TerrainSampling>({ includeTerrain: true, terrainStep: 2 })
  const [report, setReport] = useState<BakeReport | null>(null)
  const [baking, setBaking] = useState(false)

  useEffect(() => { setReport(null) }, [props.node])

  const bake = () => {
    setBaking(true)
    // Deferred a frame so the button can paint its disabled state first: the bake is synchronous and
    // would otherwise block the very paint it is meant to show.
    setTimeout(() => {
      try {
        const started = performance.now()
        const gathered = gatherNavSoup(editorScene.root, {
          includeTerrain: state.includeTerrain,
          terrainStep: state.terrainStep,
          // Null when unbounded, which gathers the whole scene exactly as before.
          volume: props.node.invVolumeMatrix,
        })
        const result = bakeNavMesh(gathered.soup, props.node.bake, {
          obstacles: gathered.obstacles,
          agentRadius: props.node.agentRadius,
        })
        props.node.setData(result.data)
        // Recorded so the panel can tell a bake that covers the current box from one that covers a
        // box the author has since moved. The two are indistinguishable in the viewport otherwise.
        props.node.bakedVolume = props.node.volumeBounds()
        setReport({
          regions: result.regions,
          walkable: result.walkableTriangles,
          rejected: result.rejectedTriangles,
          colliders: gathered.colliders,
          terrains: gathered.terrains,
          obstacles: props.node.bake.carve ? gathered.obstacles.length : 0,
          ms: performance.now() - started,
          bounded: props.node.bounded,
        })
        eventEmitter.emit('SCENE_CHANGED')
      } finally {
        setBaking(false)
      }
    }, 0)
  }

  const clear = () => {
    props.node.setData({ vertices: new Float32Array(0), counts: new Uint32Array(0) })
    props.node.bakedVolume = null
    setReport(null)
    eventEmitter.emit('SCENE_CHANGED')
  }

  /**
   * Size the box around everything a bake would find, and centre the node on it.
   *
   * Gathers unclipped on purpose — fitting to the CURRENT box would only ever shrink it, so a box
   * that has drifted off the level could never be recovered by pressing this.
   */
  const fitToScene = () => {
    const soup = gatherNavSoup(editorScene.root, {
      includeTerrain: state.includeTerrain, terrainStep: state.terrainStep,
    }).soup
    if (soup.positions.length < 9) return

    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < soup.positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], soup.positions[i + a])
        max[a] = Math.max(max[a], soup.positions[i + a])
      }

    // A margin, and a floor under each axis: a dead-flat level has zero Y extent, and a zero size
    // reads as "unbounded" — which would silently be the opposite of what this button promises.
    const pad = 1
    const scale = props.node.worldScale
    const size = [0, 1, 2].map(a =>
      Math.max((max[a] - min[a]) + pad * 2, 1) / Math.max(Math.abs(scale[a]), 1e-6))

    props.node.setPosition([
      (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
    ])
    props.node.size = [size[0], size[1], size[2]]
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
  }

  // Label-less: each slider sits in a PropertyRow, so it lines up with every other row in the card.
  const bounded = props.node.bounded
  const skipped = navPreviewSkippedFor(props.node.id)

  // One status line instead of a stack of paragraphs; the full explanation rides on its tooltip.
  const status: { text: string; title: string; warn?: boolean } | null =
    skipped !== null
      ? { warn: true, text: `Preview off: ${skipped.toLocaleString()} walkable triangles.`,
          title: 'Too many to paint, so the cyan preview is off for this volume. The box and the bake are unaffected; shrink the volume, or raise the terrain sample step, to get the preview back.' }
    : bounded && props.node.bakeIsStale
      ? { warn: true, text: 'The box moved since the last bake — re-bake.',
          title: 'The wireframe no longer describes the box. Re-bake to make the two agree.' }
    : !bounded
      ? { text: 'Unbounded: the whole scene is baked.',
          title: 'The dimmed box in the viewport is its extent. Give all three sizes a value to restrict it to a box you can place and drag.' }
    : null

  const reportText = report
    ? (report.regions === 0
        ? 'Nothing walkable found — ground needs a collider.'
        : `${report.regions} regions · ${report.ms.toFixed(0)} ms`)
    : !props.node.isBaked && !baking ? 'Not baked yet.' : ''
  const reportTitle = report
    ? `${report.regions} regions from ${report.walkable} walkable triangles, ${report.rejected} rejected as too steep or degenerate. ` +
      `Sources: ${report.colliders} colliders, ${report.terrains} terrain${report.bounded ? ', clipped to the box' : ', whole scene'}. ` +
      `${report.obstacles} obstacles carved.`
    : 'Controllers set to path walk in a straight line until this mesh exists, so nothing breaks — they just stop going around things.'

  // Documented on the AI agents page, not with the other node-type editors.
  return (
    <DocScope page='editor/ai-agents'>
    <Collapsable title='Nav Mesh' doc='editor/ai-agents#navigation-meshes' icon={<NavMeshIcon />} persistKey='navMesh'>
      <div className='w-full p-2'>
        <DeclaredSection node={props.node} title='' keys={['size']} columns={['32%', '68%']} />
        <PropertyTable columns={['32%', '68%']}>
          <PropertyRow label='Bake'>
            <span className='flex items-center gap-1'>
              <Button size='sm' onClick={bake} disabled={baking}>{baking ? 'Baking…' : 'Bake'}</Button>
              {props.node.isBaked && <Button size='sm' variant='ghost' onClick={clear}>Clear</Button>}
              <Button size='sm' variant='ghost' className='ml-auto' onClick={fitToScene}
                title='Resize the box around everything walkable'>Fit</Button>
            </span>
          </PropertyRow>
        </PropertyTable>
        <DeclaredSection node={props.node} title='' skip={['size']} columns={['32%', '68%']} />
        <PropertyTable columns={['32%', '68%']}>
          <PropertyRow label='Terrain'>
            <span className='flex items-center gap-2'>
              <Toggle checked={state.includeTerrain} onChange={(c) => setState({ ...state, includeTerrain: c })} />
              {state.includeTerrain && (
                <Slider min={1} max={8} step={1} value={state.terrainStep} className='my-0 flex-1'
                  title='Sample step: every Nth terrain vertex' readout={(v) => '1/' + v.toFixed(0)}
                  onChange={(v) => setState({ ...state, terrainStep: v })} />
              )}
            </span>
          </PropertyRow>
        </PropertyTable>
        {(status || reportText) && (
          <div className='mt-1 space-y-0.5 text-ui-sm'>
            {status && <div className={cn(status.warn ? 'text-warning' : 'text-muted', 'cursor-help')} title={status.title}>{status.text}</div>}
            {reportText && <div className='text-muted cursor-help' title={reportTitle}>{reportText}</div>}
          </div>
        )}
      </div>
    </Collapsable>
    </DocScope>
  )
}
