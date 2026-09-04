import { useEffect, useState } from 'react'
import { NavMeshNode, bakeNavMesh, navBakeSettings } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { Button, Slider, Toggle, cn, labelClass, sectionTitleClass } from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'
import { gatherNavSoup } from '../../../utils/navBakeSources'
import { NavMeshIcon } from '../../sceneInspector/nodeIcons'

const NAV_HINT = 'The walkable surface AI pathfinds over. Baked from the scene colliders and terrain, in world space — so this node’s own transform is deliberately ignored, and moving it never invalidates a path.'
const SOURCE_HINT = 'Colliders, not render meshes: an invisible collider blocking a corridor has no mesh, a LOD group holds three copies of one floor, and a skinned mesh contributes a bind pose. The bake agrees with the physics rather than approximating it.'
const SLOPE_HINT = 'Steepest incline an agent will walk. Anything steeper is a wall — including, deliberately, the underside of everything, because a ceiling is a floor with its normal reversed.'
const WELD_HINT = 'Snaps nearby vertices together before linking. Load-bearing, not an optimisation: two surfaces are joined only when their shared edge matches EXACTLY, so a hairline seam between meshes becomes two disconnected islands and every path across it silently fails.'
const TERRAIN_HINT = 'Sample terrain heightfields. Step 1 is every vertex — far more detail than a planar navmesh can use, and a 129² terrain is 32,768 triangles.'
const RADIUS_HINT = 'How far an agent keeps off a corner when following a path from this mesh. Applied per path rather than baked in, which is what lets a child and an ogre share one navmesh.'

interface NavState {
  maxSlope: number
  weldTolerance: number
  simplifyTolerance: number
  agentRadius: number
  includeTerrain: boolean
  terrainStep: number
}

function readNode(node: NavMeshNode): NavState {
  return {
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
        })
        const result = bakeNavMesh(gathered.soup, props.node.bake)
        props.node.setData(result.data)
        setReport({
          regions: result.regions,
          walkable: result.walkableTriangles,
          rejected: result.rejectedTriangles,
          colliders: gathered.colliders,
          terrains: gathered.terrains,
          ms: performance.now() - started,
        })
        eventEmitter.emit('SCENE_CHANGED')
      } finally {
        setBaking(false)
      }
    }, 0)
  }

  const clear = () => {
    props.node.setData({ vertices: new Float32Array(0), counts: new Uint32Array(0) })
    setReport(null)
    eventEmitter.emit('SCENE_CHANGED')
  }

  const slider = (label: string, k: keyof NavState, min: number, max: number, step: number, fixed = 2, hint?: string) => (
    <Slider label={label} min={min} max={max} step={step} value={state[k] as number} title={hint}
      labelClassName='w-[104px]' readout={(v) => v.toFixed(fixed)}
      onChange={(v) => apply({ [k]: v } as Partial<NavState>)} />
  )

  const header = (label: string, hint?: string) => (
    <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(hint))} title={hint}>{label}</div>
  )

  return (
    <Collapsable title='Nav Mesh' icon={<NavMeshIcon />} persistKey='navMesh' hint={NAV_HINT}>
      <div className='w-full p-2'>
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
            <div>Sources: {report.colliders} colliders, {report.terrains} terrain.</div>
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
