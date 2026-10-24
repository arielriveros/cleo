import { useEffect, useState } from 'react'
import { NavMeshNode, bakeNavMesh, navBakeSettings } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import {
  Button, DocScope, NumberInput, PropertyRow, PropertyTable, Slider, Toggle, cn,
} from '../../../components/ui'
import { gatherNavSoup } from '../../../utils/navBakeSources'
import { navPreviewSkippedFor } from '../../../utils/editorHelpers'
import { NavMeshIcon } from '../../sceneInspector/nodeIcons'

// Every row's explanation is its row in docs/editor/ai-agents.md › Navigation meshes, shown as the
// label's hover card; only the live status lines below carry their own tooltips.

interface NavState {
  sizeX: number
  sizeY: number
  sizeZ: number
  maxSlope: number
  weldTolerance: number
  simplifyTolerance: number
  agentRadius: number
  carve: boolean
  agentHeight: number
  includeTerrain: boolean
  terrainStep: number
}

function readNode(node: NavMeshNode): NavState {
  return {
    sizeX: node.size[0],
    sizeY: node.size[1],
    sizeZ: node.size[2],
    maxSlope: node.bake.maxSlope,
    weldTolerance: node.bake.weldTolerance,
    simplifyTolerance: node.bake.simplifyTolerance,
    agentRadius: node.agentRadius,
    carve: node.bake.carve,
    agentHeight: node.bake.agentHeight,
    includeTerrain: true,
    terrainStep: 2,
  }
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
  const { eventEmitter, editorScene, bodies } = useCleoEngine()
  const [state, setState] = useState<NavState>(() => readNode(props.node))
  const [report, setReport] = useState<BakeReport | null>(null)
  const [baking, setBaking] = useState(false)

  useEffect(() => { setState(readNode(props.node)); setReport(null) }, [props.node])

  const apply = (patch: Partial<NavState>) => {
    const next = { ...state, ...patch }
    // The bake block is nested on the node; the two terrain fields are not stored at all, because they
    // describe how to GATHER rather than what was baked.
    // Spread first: fields this panel has no row for (mergeRegions, stepHeight) must survive an edit.
    props.node.bake = navBakeSettings({
      ...props.node.bake,
      maxSlope: next.maxSlope,
      weldTolerance: next.weldTolerance,
      simplifyTolerance: next.simplifyTolerance,
      carve: next.carve,
      agentHeight: next.agentHeight,
    })
    props.node.agentRadius = next.agentRadius
    props.node.size = [next.sizeX, next.sizeY, next.sizeZ]
    setState(next)
    eventEmitter.emit('SCENE_CHANGED')
  }

  const bake = () => {
    setBaking(true)
    // Deferred a frame so the button can paint its disabled state first: the bake is synchronous and
    // would otherwise block the very paint it is meant to show.
    setTimeout(() => {
      try {
        const started = performance.now()
        const gathered = gatherNavSoup(editorScene.root, {
          bodies,
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
      bodies, includeTerrain: state.includeTerrain, terrainStep: state.terrainStep,
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
    apply({ sizeX: size[0], sizeY: size[1], sizeZ: size[2] })
  }

  // Label-less: each slider sits in a PropertyRow, so it lines up with every other row in the card.
  const slider = (k: keyof NavState, min: number, max: number, step: number, fixed = 2,
                  readout?: (v: number) => string) => (
    <Slider min={min} max={max} step={step} value={state[k] as number} className='my-0'
      readout={readout ?? ((v) => v.toFixed(fixed))}
      onChange={(v) => apply({ [k]: v } as Partial<NavState>)} />
  )

  const bounded = state.sizeX > 0 && state.sizeY > 0 && state.sizeZ > 0
  // What the viewport preview declined to draw, if anything. Read from the reconciler rather than
  // recomputed: it already worked this out this frame, and a preview that is silently absent on
  // exactly the biggest levels is the failure this whole panel exists to make visible.
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
        <PropertyTable columns={['32%', '68%']}>
          <PropertyRow label='Size'>
            <span className='flex gap-1'>
              {(['sizeX', 'sizeY', 'sizeZ'] as const).map((k, i) => (
                <NumberInput key={k} className='min-w-0 flex-1' min={0} step={0.5} value={state[k]}
                  title={['Size X', 'Size Y', 'Size Z'][i] + ' — 0 bakes the whole scene'}
                  onChange={(v) => apply({ [k]: Math.max(0, v) } as Partial<NavState>)} />
              ))}
            </span>
          </PropertyRow>
          <PropertyRow label='Bake'>
            <span className='flex items-center gap-1'>
              <Button size='sm' onClick={bake} disabled={baking}>{baking ? 'Baking…' : 'Bake'}</Button>
              {props.node.isBaked && <Button size='sm' variant='ghost' onClick={clear}>Clear</Button>}
              <Button size='sm' variant='ghost' className='ml-auto' onClick={fitToScene}
                title='Resize the box around everything walkable'>Fit</Button>
            </span>
          </PropertyRow>
          <PropertyRow label='Max slope'>{slider('maxSlope', 0, 89, 1, 0, (v) => v.toFixed(0) + '°')}</PropertyRow>
          <PropertyRow label='Weld'>{slider('weldTolerance', 0.001, 0.5, 0.001, 3)}</PropertyRow>
          <PropertyRow label='Simplify'>{slider('simplifyTolerance', 0, 0.5, 0.001, 3)}</PropertyRow>
          <PropertyRow label='Agent radius'>{slider('agentRadius', 0, 5, 0.05)}</PropertyRow>
          <PropertyRow label='Carve obstacles'>
            <Toggle checked={state.carve} onChange={(c) => apply({ carve: c })} />
          </PropertyRow>
          {state.carve && (
            <PropertyRow label='Agent height'>{slider('agentHeight', 0.5, 5, 0.05)}</PropertyRow>
          )}
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
