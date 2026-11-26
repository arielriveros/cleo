import { useEffect, useRef, type RefObject } from 'react'
import { mat4, vec3 } from 'gl-matrix'
import {
  PhysicsBody, Raycaster, markEditorOwned, parseRagdollProfile, autoHumanoidProfile, ragdollLayout, ragdollPartPose,
  type ModelNode, type ReactionController,
} from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useRig } from '../RigContext'
import { getAnimationTarget } from '../../animation/skeleton'
import { wireModel } from '../../../utils/editorHelpers'
import { partLines } from '../../../utils/ragdollWire'
import { benchStore, type BenchAction } from './benchStore'
import { benchLayout, boxLines } from './scenarios'
import { benchReactionSet } from './benchSet'

// The Reactions tab's test bench, in the rig editor's viewport: builds the scenario's props round the preview
// character (stairs, a ramp, a ledge, a moving cart, a wall), runs its reactions on the set being edited, lets the
// mouse shoot or shove it, slows, pauses and steps the clock, records the last twenty seconds for the replay and
// the timeline, and draws what the reaction sees: the pose its muscles reach for, its balance and where it will
// land. Everything it adds is an editor-owned node or a body of the throwaway preview scene, gone when it ends.

const PROP = [0.55, 0.6, 0.7] as [number, number, number]
const GHOST = [0.4, 1, 0.55] as [number, number, number]
const BALANCE = [1, 0.85, 0.2] as [number, number, number]
const IMPACT = [1, 0.35, 0.3] as [number, number, number]

interface Prop { body: PhysicsBody; visual: ModelNode; velocity?: [number, number, number] }
interface Run {
  node: ModelNode
  reactions: ReactionController
  props: Prop[]
  saved: { position: vec3; quaternion: [number, number, number, number]; animations: boolean | null; timeScale: number }
  markers: { com: ModelNode; capture: ModelNode; impact: ModelNode; ghosts: ModelNode[] }
  startAt: number
  action: ReturnType<typeof benchLayout>
  acted: boolean
  last: number
}

/** A cross of three lines (a point marker). */
const cross = (s: number) => ({
  positions: [[-s, 0, 0], [s, 0, 0], [0, -s, 0], [0, s, 0], [0, 0, -s], [0, 0, s]] as [number, number, number][],
  indices: [0, 1, 2, 3, 4, 5],
})
/** A ring on the ground. */
const ring = (r: number, n = 20) => {
  const positions: [number, number, number][] = [], indices: number[] = []
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; positions.push([Math.cos(a) * r, 0, Math.sin(a) * r]); indices.push(i, (i + 1) % n) }
  return { positions, indices }
}

export default function ReactionBench({ viewportRef }: { viewportRef: RefObject<HTMLDivElement> }) {
  const { editorScene, skeletonTargetId, instance, withoutDirty } = useCleoEngine()
  const { asset } = useRig()
  const { poseAssets } = useAssetLibrary()
  const runRef = useRef<Run | null>(null)
  const target = getAnimationTarget(editorScene, skeletonTargetId)
  // What the bench reads in its callbacks: the current rig, poses and target.
  const live = useRef({ asset, poseAssets, target })
  live.current = { asset, poseAssets, target }

  const end = () => {
    const run = runRef.current
    runRef.current = null
    if (!run) return
    const physics = instance?.physics
    try { run.reactions.reset() } catch { /* the preview may be gone */ }
    withoutDirty(() => {
      for (const p of run.props) {
        try { physics?.removeBody(p.body) } catch { /* gone */ }
        try { run.node.scene?.removeNode(p.visual) } catch { /* gone */ }
      }
      for (const m of [run.markers.com, run.markers.capture, run.markers.impact, ...run.markers.ghosts]) {
        try { run.node.scene?.removeNode(m) } catch { /* gone */ }
      }
      run.node.setPosition(run.saved.position)
      run.node.setQuaternion(run.saved.quaternion)
    })
    if (instance) instance.timeScale = run.saved.timeScale
    if (run.saved.animations !== null && run.node.scene) {
      run.node.scene.animationsEnabled = run.saved.animations
      if (!run.saved.animations) run.node.animator?.showBindPose()
    }
    benchStore.set({ running: false, paused: false, live: null, scrub: null })
  }

  const start = (): Run | null => {
    end()
    const t = live.current.target
    if (!t || !instance) return null
    const scene = t.node.scene
    if (!scene) return null
    const physics = instance.physics
    const reactions = physics.reactionsOf(t.node)
    if (!reactions) return null
    // The floor: the preview character's lowest joint as it stands.
    const fbm = t.animator.getFinalBoneMatrices(), world = t.node.worldTransform as mat4
    const bind = mat4.create(), m = mat4.create()
    let floor = Infinity
    t.skin.joints.forEach((j, i) => {
      if (!mat4.invert(bind, j.inverseBindMatrix as mat4)) return
      mat4.multiply(m, world, fbm[i]); mat4.multiply(m, m, bind)
      if (Number.isFinite(m[13])) floor = Math.min(floor, m[13])
    })
    if (!Number.isFinite(floor)) floor = 0
    const { scenario, options } = benchStore.get()
    const layout = benchLayout(scenario, options, floor)
    const props: Prop[] = []
    const saved = {
      position: vec3.clone(t.node.position as vec3),
      quaternion: [...(t.node.quaternion as unknown as number[])] as [number, number, number, number],
      animations: scene.animationsEnabled, timeScale: instance.timeScale,
    }
    let markers!: Run['markers']
    withoutDirty(() => {
      layout.boxes.forEach((b, i) => {
        const half = b.pitch ? Math.PI * b.pitch / 360 : 0
        const q: [number, number, number, number] = [Math.sin(half), 0, 0, Math.cos(half)]
        const body = new PhysicsBody({ name: 'bench', mass: 0, type: b.velocity ? 'kinematic' : 'static', position: b.center, quaternion: q })
        body.addCollider({ shape: { kind: 'box', halfExtents: b.half } })
        physics.addBody(body)
        const visual = wireModel(`__editor__bench_prop_${i}`, boxLines(b.half), PROP)
        markEditorOwned(visual)
        scene.addNode(visual)
        visual.setPosition(b.center)
        visual.setQuaternion(q)
        props.push({ body, visual, ...(b.velocity ? { velocity: b.velocity } : {}) })
      })
      const marker = (name: string, lines: { positions: [number, number, number][]; indices: number[] }, color: [number, number, number]) => {
        const n = wireModel(name, lines, color)
        markEditorOwned(n)
        scene.addNode(n)
        n.setPosition([0, -1000, 0])
        return n
      }
      const profile = parseRagdollProfile(t.skin.ragdollProfile ?? autoHumanoidProfile(t.skin))
      const ghostLayout = profile ? ragdollLayout(t.skin, profile) : null
      markers = {
        com: marker('__editor__bench_com', cross(0.08), BALANCE),
        capture: marker('__editor__bench_capture', ring(0.06, 12), BALANCE),
        impact: marker('__editor__bench_impact', ring(0.18), IMPACT),
        ghosts: ghostLayout ? ghostLayout.parts.map((lp, i) => marker(`__editor__bench_ghost_${i}`, partLines(lp), GHOST)) : [],
      }
      // Stand it where the scenario starts (feet on the prop), as it faces.
      const p = t.node.position
      t.node.setPosition([p[0] + layout.start[0], p[1] + layout.start[1] - floor, p[2] + layout.start[2]])
    })
    scene.animationsEnabled = true
    reactions.reset()
    reactions.set = benchReactionSet(live.current.asset?.reactions, live.current.poseAssets, benchStore.get().set)
    benchStore.recorder.clear()
    const run: Run = { node: t.node, reactions, props, saved, markers, startAt: performance.now(), action: layout, acted: false, last: performance.now() }
    runRef.current = run
    instance.timeScale = benchStore.get().paused ? 0 : benchStore.get().slow
    benchStore.set({ running: true, scrub: null })
    return run
  }

  const act = (what: string, run: Run) => {
    const r = run.reactions, l = run.action
    switch (what) {
      case 'trip': r.trip(); break
      case 'fall': if (l.velocity) r.push(l.velocity); r.fall(); break
      // The cart lets the body through for a moment, so it does not catch on the deck it leaves.
      case 'bail': r.bail({ velocity: l.velocity ?? [0, 0, 8], exitDirection: l.exit ?? [1, 0, 0], vehicle: run.props.find(p => p.velocity) ?? null }); break
      case 'push': r.push(l.velocity ?? [0, 0.3, 2.5]); break
      case 'knockOut': r.knockOut(); break
      case 'kill': r.kill(); break
      case 'getUp': r.getUp(); break
      case 'hit': r.hit({ part: 'Chest', direction: [0, 0, -1], impulse: benchStore.get().impulse }); break
    }
  }

  // The tab's requests.
  useEffect(() => benchStore.onAction((a: BenchAction) => {
    if (a.kind === 'reset') { end(); return }
    if (a.kind === 'start') { start(); return }
    const run = runRef.current ?? start()
    if (!run) return
    if (a.kind === 'act') act(a.what, run)
    else if (a.kind === 'step' && instance) {
      // One frame at the bench's rate, then held again.
      instance.timeScale = benchStore.get().slow
      requestAnimationFrame(() => { if (benchStore.get().paused && instance) instance.timeScale = 0 })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [instance])

  // The clock follows the tab's pause and slow motion; the replay scrubs while paused.
  useEffect(() => benchStore.subscribe(s => {
    const run = runRef.current
    if (!run || !instance) return
    instance.timeScale = s.paused ? 0 : s.slow
    if (s.paused && s.scrub !== null) {
      const frame = benchStore.recorder.atFraction(s.scrub), rg = run.reactions.ragdoll
      if (frame && rg) {
        for (const part of rg.parts) {
          const o = part.index * 7, b = part.body
          b.position.set(frame.poses[o], frame.poses[o + 1], frame.poses[o + 2])
          b.quaternion.set(frame.poses[o + 3], frame.poses[o + 4], frame.poses[o + 5], frame.poses[o + 6])
          b.velocity.set(0, 0, 0)
          b.angularVelocity.set(0, 0, 0)
        }
        run.node.animator?.update(0)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [instance])

  // The mouse: shoot or shove the part under it.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !instance) return
    const onDown = (e: MouseEvent) => {
      const tool = benchStore.get().tool
      if (e.button !== 0 || tool === 'none' || !instance.scene?.activeCamera) return
      if ((e.target as HTMLElement)?.closest?.('[data-cleo-overlay]')) return
      const t = live.current.target
      if (!t) return
      const rect = viewport.getBoundingClientRect()
      const ray = Raycaster.screenToRay(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, instance.scene.activeCamera.camera)
      const dir = vec3.normalize(vec3.create(), ray.direction as vec3)
      const from = ray.origin as vec3, to = vec3.scaleAndAdd(vec3.create(), from, dir, 200)
      const reactions = instance.physics.reactionsOf(t.node)
      const hit = reactions?.partByRay(from, to)
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      const run = runRef.current ?? start()
      if (!run) return
      const J = benchStore.get().impulse
      if (tool === 'shoot') run.reactions.hit({ part: hit.part, point: hit.point, direction: dir, impulse: J })
      else run.reactions.push([dir[0] * J / 70, Math.max(0, dir[1]) * J / 70, dir[2] * J / 70], hit.part)
    }
    viewport.addEventListener('mousedown', onDown, true)
    return () => viewport.removeEventListener('mousedown', onDown, true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, viewportRef])

  // Every frame: move the moving props, start the scenario's action, draw the overlays, record.
  useEffect(() => {
    let raf = 0
    let liveAt = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const run = runRef.current
      if (!run || !instance) return
      const now = performance.now()
      const dt = Math.min(0.1, (now - run.last) / 1000) * (benchStore.get().paused ? 0 : benchStore.get().slow)
      run.last = now
      for (const p of run.props) {
        if (!p.velocity || dt <= 0) continue
        const b = p.body
        b.position.set(b.position.x + p.velocity[0] * dt, b.position.y + p.velocity[1] * dt, b.position.z + p.velocity[2] * dt)
        b.velocity.set(p.velocity[0], p.velocity[1], p.velocity[2])
        p.visual.setPosition([b.position.x, b.position.y, b.position.z])
        // Riding: the character goes along until it bails.
        if (run.action.rides && !run.acted) {
          const n = run.node.position
          withoutDirty(() => run.node.setPosition([n[0] + p.velocity![0] * dt, n[1] + p.velocity![1] * dt, n[2] + p.velocity![2] * dt]))
        }
      }
      if (!run.acted && now - run.startAt > 400 && run.action.action !== 'none') { run.acted = true; act(run.action.action, run) }
      const r = run.reactions, s = r.sensors, { overlays } = benchStore.get()
      const away: [number, number, number] = [0, -1000, 0]
      withoutDirty(() => {
        const has = !!r.ragdoll
        run.markers.com.setPosition(has && overlays.balance ? s.com : away)
        run.markers.capture.setPosition(has && overlays.balance && Number.isFinite(s.groundY) ? [s.capture[0], s.groundY + 0.01, s.capture[1]] : away)
        run.markers.impact.setPosition(has && overlays.impact && s.impact ? s.impact.point : away)
        // The pose the muscles reach for, where the animation has it.
        const t = live.current.target
        const profile = t ? parseRagdollProfile(t.skin.ragdollProfile ?? autoHumanoidProfile(t.skin)) : null
        if (t && profile && has && overlays.target) {
          const layout = ragdollLayout(t.skin, profile)
          const bones = t.animator.getTargetBoneMatrices(), world = t.node.worldTransform as mat4
          layout.parts.forEach((lp, i) => {
            const g = run.markers.ghosts[i]
            if (!g) return
            const pose = ragdollPartPose(t.skin, lp, world, bones[lp.joint])
            g.setPosition([pose.center[0], pose.center[1], pose.center[2]])
            g.setQuaternion([pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]])
            g.setUniformScale(pose.scale)
          })
        } else for (const g of run.markers.ghosts) g.setPosition(away)
      })
      // Record what happened this frame.
      const rg = r.ragdoll
      if (rg && dt > 0) {
        const poses = new Float32Array(rg.parts.length * 7)
        for (const p of rg.parts) {
          const b = p.body, o = p.index * 7
          poses[o] = b.position.x; poses[o + 1] = b.position.y; poses[o + 2] = b.position.z
          poses[o + 3] = b.quaternion.x; poses[o + 4] = b.quaternion.y; poses[o + 5] = b.quaternion.z; poses[o + 6] = b.quaternion.w
        }
        benchStore.recorder.push({ t: now / 1000, state: r.state, poses, behaviours: Object.fromEntries(r.behaviours) })
      }
      if (now - liveAt > 100) {
        liveAt = now
        benchStore.set({ live: { state: r.state, behaviours: Object.fromEntries(r.behaviours), health: r.health } })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance])

  // The working set follows the tab's edits while a run goes on.
  useEffect(() => {
    const run = runRef.current
    if (run) run.reactions.set = benchReactionSet(asset?.reactions, poseAssets, benchStore.get().set)
  }, [asset?.reactions, poseAssets])

  // Leaving the rig (or swapping its preview model) ends the run.
  useEffect(() => () => end(), [target?.node]) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}
