import { useEffect, useState } from 'react'
import { NavMeshNode, bakeNavMesh, navBakeSettings } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import {
  Button, NumberInput, PropertyRow, PropertyTable, Slider, Toggle, cn, labelClass, sectionTitleClass,
} from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'
import { gatherNavSoup } from '../../../utils/navBakeSources'
import { navPreviewSkippedFor } from '../../../utils/editorHelpers'
import { NavMeshIcon } from '../../sceneInspector/nodeIcons'

const NAV_HINT = 'The walkable surface AI pathfinds over. Baked from the scene colliders and terrain inside this node’s box. The contours are stored in WORLD space, so moving the node never invalidates a path that already exists — it changes what the NEXT bake will cover.'
const BOUNDS_HINT = 'The box that decides what gets baked. Drag and scale the node to place it; while it is selected the box is outlined and every walkable surface inside it is painted cyan, which is exactly what a bake would keep. Set any size to 0 to bake the whole scene instead.'
const SOURCE_HINT = 'Colliders, not render meshes: an invisible collider blocking a corridor has no mesh, a LOD group holds three copies of one floor, and a skinned mesh contributes a bind pose. The bake agrees with the physics rather than approximating it.'
const SLOPE_HINT = 'Steepest incline an agent will walk. Anything steeper is a wall — including, deliberately, the underside of everything, because a ceiling is a floor with its normal reversed.'
const WELD_HINT = 'Snaps nearby vertices together before linking. Load-bearing, not an optimisation: two surfaces are joined only when their shared edge matches EXACTLY, so a hairline seam between meshes becomes two disconnected islands and every path across it silently fails.'
const TERRAIN_HINT = 'Sample terrain heightfields. Step 1 is every vertex — far more detail than a planar navmesh can use, and a 129² terrain is 32,768 triangles.'
const RADIUS_HINT = 'How far an agent keeps off a corner when following a path from this mesh. Applied per path rather than baked in, which is what lets a child and an ogre share one navmesh.'

interface NavState {
  sizeX: number
  sizeY: number
  sizeZ: number
  maxSlope: number
  weldTolerance: number
  simplifyTolerance: number
  agentRadius: number
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
    props.node.bake = navBakeSettings({
      maxSlope: next.maxSlope,
      weldTolerance: next.weldTolerance,
      simplifyTolerance: next.simplifyTolerance,
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
        const result = bakeNavMesh(gathered.soup, props.node.bake)
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

  const slider = (label: string, k: keyof NavState, min: number, max: number, step: number, fixed = 2, hint?: string) => (
    <Slider label={label} min={min} max={max} step={step} value={state[k] as number} title={hint}
      labelClassName='w-[104px]' readout={(v) => v.toFixed(fixed)}
      onChange={(v) => apply({ [k]: v } as Partial<NavState>)} />
  )

  const bounded = state.sizeX > 0 && state.sizeY > 0 && state.sizeZ > 0
  // What the viewport preview declined to draw, if anything. Read from the reconciler rather than
  // recomputed: it already worked this out this frame, and a preview that is silently absent on
  // exactly the biggest levels is the failure this whole panel exists to make visible.
  const skipped = navPreviewSkippedFor(props.node.id)

  const header = (label: string, hint?: string) => (
    <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(hint))} title={hint}>{label}</div>
  )

  return (
    <Collapsable title='Nav Mesh' icon={<NavMeshIcon />} persistKey='navMesh' hint={NAV_HINT}>
      <div className='w-full p-2'>
        {header('Bounds', BOUNDS_HINT)}
        <PropertyTable>
          {(['sizeX', 'sizeY', 'sizeZ'] as const).map((k, i) => (
            <PropertyRow key={k} label={['Size X', 'Size Y', 'Size Z'][i]}>
              <NumberInput min={0} step={0.5} value={state[k]}
                onChange={(v) => apply({ [k]: Math.max(0, v) } as Partial<NavState>)} />
            </PropertyRow>
          ))}
        </PropertyTable>
        <div className='flex items-center gap-2 my-2'>
          <Button size='sm' variant='ghost' onClick={fitToScene}>Fit to scene</Button>
        </div>
        {!bounded && (
          <p className='text-[11px] text-muted mb-2'>
            Unbounded — the whole scene is baked, and the dimmed box in the viewport is its extent.
            Give all three sizes a value to restrict it to a box you can place and drag.
          </p>
        )}
        {skipped !== null && (
          <p className='text-[11px] text-warning mb-2'>
            {skipped.toLocaleString()} walkable triangles — too many to paint, so the cyan preview is
            off for this volume. The box and the bake are unaffected; shrink the volume, or raise the
            terrain sample step below, to get the preview back.
          </p>
        )}
        {bounded && props.node.bakeIsStale && (
          <p className='text-[11px] text-warning mb-2'>
            The box has moved since the last bake, so the wireframe below no longer describes it.
            Re-bake to make the two agree.
          </p>
        )}

        {header('Bake', SOURCE_HINT)}
        <div className='flex items-center gap-2 mb-2'>
          <Button size='sm' onClick={bake} disabled={baking}>{baking ? 'Baking…' : 'Bake'}</Button>
          {props.node.isBaked && <Button size='sm' variant='ghost' onClick={clear}>Clear</Button>}
        </div>

        {!props.node.isBaked && !baking && (
          <p className='text-[11px] text-muted mb-2'>
            Nothing baked yet. Controllers set to <code>path</code> walk in a straight line until this
            mesh exists, so nothing breaks — they just stop going around things.
          </p>
        )}

        {report && (
          <div className='text-[11px] text-muted mb-2 leading-relaxed'>
            <div>{report.regions} regions from {report.walkable} walkable triangles, {report.rejected} rejected as too steep or degenerate.</div>
            <div>
              Sources: {report.colliders} colliders, {report.terrains} terrain
              {report.bounded ? ', clipped to the box' : ', whole scene'}.
            </div>
            <div>{report.ms.toFixed(0)} ms.</div>
            {report.regions === 0 && (
              <div className='mt-1'>
                Nothing walkable was found. Ground needs a collider — the bake reads colliders, not
                meshes.
              </div>
            )}
          </div>
        )}

        {header('Surface')}
        {slider('Max slope', 'maxSlope', 0, 89, 1, 0, SLOPE_HINT)}
        {slider('Weld', 'weldTolerance', 0.001, 0.5, 0.001, 3, WELD_HINT)}
        {slider('Simplify', 'simplifyTolerance', 0, 0.5, 0.001, 3)}

        {header('Agents', RADIUS_HINT)}
        {slider('Agent radius', 'agentRadius', 0, 5, 0.05)}

        {header('Terrain', TERRAIN_HINT)}
        <Toggle label='Include terrain' checked={state.includeTerrain} className='my-1'
          onChange={(c) => setState({ ...state, includeTerrain: c })} />
        {state.includeTerrain && (
          <div className='flex items-center justify-between mt-1'>
            <span className={labelClass}>Sample step</span>
            <Slider label='' min={1} max={8} step={1} value={state.terrainStep}
              labelClassName='w-0' readout={(v) => 'every ' + v.toFixed(0)}
              onChange={(v) => setState({ ...state, terrainStep: v })} />
          </div>
        )}
      </div>
    </Collapsable>
  )
}
