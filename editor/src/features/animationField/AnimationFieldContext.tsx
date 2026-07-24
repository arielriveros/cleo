import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { getAnimationTarget, AnimationTarget } from '../animation/skeleton'
import {
  AnimationFieldAsset, AnimationFieldSample, AnimationFieldAxis, AnimationFieldMode,
  toRuntimeField, DEFAULT_X_AXIS, DEFAULT_Y_AXIS,
} from '../../utils/animationFields'

// Shared editing session for one Animation Field, mirroring StateMachineContext. The blend-space plot
// (FieldGraph), the sidebar (AnimationFieldPanel) and the transport (AnimationFieldPlayer) all edit the
// SAME working copy, so it lives here and is provided to the whole dock.
//
// The PROBE (the point the field is sampled at) is session state, never part of the asset: it is where the
// user is currently looking in the blend space, not something the game should inherit.

interface AnimationFieldContextValue {
  /** The skinned model previewing the field, or null when the tab has no valid target. */
  target: AnimationTarget | null
  /** Clip names available on that model. */
  clips: string[]
  /**
   * Clip name -> authored length in seconds.
   *
   * Surfaced because a blend plays each clip at its OWN rate, so a clip whose authored length is out of line
   * with its neighbours is the single most common reason one corner of a field "plays too fast" — and
   * without this the length is invisible everywhere in the editor except the animation transport.
   */
  clipDurations: Record<string, number>
  /** The working copy. Never mutate — go through the setters. */
  field: AnimationFieldAsset | null

  setName: (name: string) => void
  setMode: (mode: AnimationFieldMode) => void
  setAxis: (which: 'x' | 'y', patch: Partial<AnimationFieldAxis>) => void
  addSample: (at?: { x: number; y: number }) => void
  setSample: (i: number, patch: Partial<AnimationFieldSample>) => void
  removeSample: (i: number) => void

  /** Index of the sample selected in the plot / sidebar, or -1. */
  selected: number
  setSelected: (i: number) => void

  /** Where the field is being sampled. Session-only. */
  probe: { x: number; y: number }
  setProbe: (x: number, y: number) => void
  /** Live per-clip weights at the probe, read back from the animator after it re-sampled. */
  weights: { clipName: string; weight: number }[]

  /** Write the working copy to the library and re-embed it wherever it is played. */
  save: () => void
  dirty: boolean
}

const Ctx = createContext<AnimationFieldContextValue | null>(null)

export function useAnimationField(): AnimationFieldContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAnimationField must be used within an AnimationFieldProvider')
  return v
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

/** A name not already taken by another sample's clip, used when adding a sample with no clip picked yet. */
function firstUnusedClip(clips: string[], samples: AnimationFieldSample[]): string {
  const used = new Set(samples.map(s => s.clipName))
  return clips.find(c => !used.has(c)) ?? clips[0] ?? ''
}

export function AnimationFieldProvider({ children }: { children: ReactNode }) {
  const {
    editorScene, editingAnimationFieldId, animationFieldTargetId,
    saveAnimationField, activeTabId, markTabDirty, clearTabDirty, registerAnimationApply, dirtyTabs,
  } = useCleoEngine()
  const { animationFields } = useAssetLibrary()

  const target = getAnimationTarget(editorScene, animationFieldTargetId)
  const clips = target ? target.model.animations.map(a => a.name) : []

  // A clip's length is the last keyframe time across its samplers — the same rule Animator uses, so what is
  // shown here is exactly what the blend will pace itself against.
  const clipDurations: Record<string, number> = {}
  for (const anim of target?.model.animations ?? []) {
    let end = 0
    for (const sampler of anim.samplers) {
      if (sampler.input.length) end = Math.max(end, sampler.input[sampler.input.length - 1])
    }
    clipDurations[anim.name] = end
  }

  const [field, setField] = useState<AnimationFieldAsset | null>(null)
  const [selected, setSelected] = useState(-1)
  const [probe, setProbeState] = useState({ x: 0, y: 0 })
  const [weights, setWeights] = useState<{ clipName: string; weight: number }[]>([])

  // Un-saved working copies per tab. There is only ever ONE live session (this provider keys off the active
  // tab), so without this, switching away from a field tab and back would reload from the library and
  // silently drop unsaved edits while the tab's dot went on claiming they existed. Same reason
  // StateMachineContext keeps smCacheRef.
  const cacheRef = useRef(new Map<string, AnimationFieldAsset>())

  // Load on entry: the tab's un-saved working copy if it has one, else the library's.
  useEffect(() => {
    if (!editingAnimationFieldId) { setField(null); setSelected(-1); return }
    const cached = cacheRef.current.get(activeTabId)
    const asset = cached ?? animationFields.find(f => f.id === editingAnimationFieldId) ?? null
    setField(asset ? clone(asset) : null)
    setSelected(-1)
    // Park the probe at the middle of the X axis so the preview shows a real blend, not an endpoint.
    if (asset) setProbeState({ x: (asset.xAxis.min + asset.xAxis.max) / 2, y: (asset.yAxis.min + asset.yAxis.max) / 2 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingAnimationFieldId, activeTabId])

  /**
   * Every mutation marks the tab dirty here rather than through the usual SCENE_CHANGED listener: the
   * working copy is React state in this provider, so editing it touches no Scene and emits nothing that
   * listener could see. (Identical to StateMachineContext's `update`.)
   */
  const update = (fn: (prev: AnimationFieldAsset) => AnimationFieldAsset) => {
    setField(prev => {
      if (!prev) return prev
      const next = fn(prev)
      cacheRef.current.set(activeTabId, next)
      return next
    })
    markTabDirty(activeTabId, 'anim-field-edit')
  }

  const setName = (name: string) => update(f => ({ ...f, name }))
  const setMode = (mode: AnimationFieldMode) => update(f => ({ ...f, mode }))
  const setAxis = (which: 'x' | 'y', patch: Partial<AnimationFieldAxis>) =>
    update(f => which === 'x' ? { ...f, xAxis: { ...f.xAxis, ...patch } } : { ...f, yAxis: { ...f.yAxis, ...patch } })

  const addSample = (at?: { x: number; y: number }) => {
    if (!field) return
    const x = at?.x ?? (field.xAxis.min + field.xAxis.max) / 2
    const y = at?.y ?? (field.yAxis.min + field.yAxis.max) / 2
    const sample: AnimationFieldSample = { clipName: firstUnusedClip(clips, field.samples), x }
    if (field.mode === '2d') sample.y = y
    update(f => ({ ...f, samples: [...f.samples, sample] }))
    setSelected(field.samples.length)
  }
  const setSample = (i: number, patch: Partial<AnimationFieldSample>) =>
    update(f => ({ ...f, samples: f.samples.map((s, idx) => idx === i ? { ...s, ...patch } : s) }))
  const removeSample = (i: number) => {
    update(f => ({ ...f, samples: f.samples.filter((_, idx) => idx !== i) }))
    setSelected(prev => (prev === i ? -1 : prev > i ? prev - 1 : prev))
  }

  const setProbe = (x: number, y: number) => setProbeState({ x, y })

  // Push the working copy into the animator whenever the field or probe changes, so the model in the
  // viewport always shows the blend as currently authored — including edits that are not yet saved.
  //
  // playField is called ONCE per target, on entry. Every later change goes through updateField/setFieldProbe,
  // which leave the phase and play state alone: dragging a sample has to change the blend mid-stride, not
  // twitch the model back to frame 0 and stop it on every pointer move.
  const shapeKey = field ? JSON.stringify(toRuntimeField(field)) : ''
  const startedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!target || !field) return
    const animator = target.animator
    const runtime = toRuntimeField(field)
    if (startedForRef.current !== animationFieldTargetId) {
      startedForRef.current = animationFieldTargetId
      animator.playField(runtime, probe.x, probe.y)
      animator.pause() // the transport decides whether it runs; entering must not start it playing
      animator.seek(0)
    } else {
      animator.updateField(runtime)
      animator.setFieldProbe(probe.x, probe.y)
    }
    setWeights(animator.activeFieldWeights)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey, probe.x, probe.y, animationFieldTargetId])

  // Leave the model in bind pose on the way out, matching the Animation Editor.
  useEffect(() => {
    if (!target) return
    const animator = target.animator
    return () => { animator.showBindPose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationFieldTargetId])

  const save = () => {
    if (!field) return
    saveAnimationField(clone(field))
    cacheRef.current.delete(activeTabId) // in sync with the library again
    clearTabDirty(activeTabId)
  }

  // Publish save so Ctrl+S / Save All can reach it — a field tab's working copy only exists here, exactly
  // like the animation tab's machine (see saveTabById).
  useEffect(() => {
    if (!field) return
    registerAnimationApply({ tabId: activeTabId, apply: save })
    return () => registerAnimationApply(null)
  })

  const value: AnimationFieldContextValue = {
    target, clips, clipDurations, field,
    setName, setMode, setAxis, addSample, setSample, removeSample,
    selected, setSelected,
    probe, setProbe, weights,
    save, dirty: !!dirtyTabs[activeTabId],
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
