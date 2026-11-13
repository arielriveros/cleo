import { useCallback, useEffect, useRef, useState } from 'react'
import { quat, vec3 } from 'gl-matrix'
import { asDerived } from 'cleo'
import type { CameraNode, Scene, SequenceNode } from 'cleo'
import { registerSequencePreview } from './previewRegistry'

/**
 * The Sequencer's preview of a Sequence node in the AUTHORED scene.
 *
 * The panel owns the clock: it seeks the node every frame while "playing" and on every scrub, and never calls
 * `play()` (an edit scene must not run a playback of its own). Every write is wrapped twice: `asDerived`, so
 * the engine raises no SCENE_CHANGED for it, and the editor's `withoutDirty`, so nothing marks the tab unsaved
 * or reaches the undo stack. The node's camera cut only REPORTS its shot while previewing (`previewCuts`
 * off), so the viewport keeps the editor camera; Pilot copies the shot onto that camera instead, and puts the
 * editor camera back when it is turned off or the preview stops.
 *
 * `stop()` hands the scene back exactly as authored. It is also registered with previewRegistry, so saving,
 * Play, a tab or 2D/3D switch and opening a scene all call it first.
 */
export interface SequencePreview {
  /** The playhead, seconds (React state, refreshed about 15 times a second while playing). */
  time: number
  /** The exact playhead, for per-frame imperative drawing. */
  timeRef: React.MutableRefObject<number>
  playing: boolean
  /** Whether the preview currently has the scene changed. */
  applied: boolean
  pilot: boolean
  loop: boolean
  seek: (t: number) => void
  play: () => void
  pause: () => void
  toggle: () => void
  stop: () => void
  setPilot: (on: boolean) => void
  setLoop: (on: boolean) => void
  /** Re-apply at the current time (after an edit). A no-op while the preview is stopped. */
  refresh: () => void
}

interface PilotSave { cam: CameraNode; pos: number[]; rot: number[]; fov: number; up: number[] }

/** The editor's camera gizmo (utils/editorHelpers.ts): hidden on the shot camera while piloting, or the view
 *  would look out from inside it. */
const CAMERA_GIZMO = '__debug__CameraModel'

export function useSequencePreview(node: SequenceNode | null, scene: Scene | null,
                                   withoutDirty: <T>(fn: () => T) => T): SequencePreview {
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [applied, setApplied] = useState(false)
  const [pilot, setPilotState] = useState(false)
  const [loop, setLoop] = useState(false)
  const timeRef = useRef(0)
  const nodeRef = useRef<SequenceNode | null>(node)
  const appliedOn = useRef<SequenceNode | null>(null)
  const pilotRef = useRef(false)
  const pilotSave = useRef<PilotSave | null>(null)
  const hiddenGizmo = useRef<{ node: { visible: boolean } } | null>(null)
  const playingRef = useRef(false)
  const loopRef = useRef(false)
  const unregister = useRef<(() => void) | null>(null)
  nodeRef.current = node
  loopRef.current = loop

  const wrap = useCallback(<T,>(fn: () => T): T => withoutDirty(() => asDerived(fn)), [withoutDirty])

  /** The editor's own camera: the pinned one (createEmptyScene `ensureEditorCamera`). */
  const editorCamera = useCallback((): CameraNode | null => (scene?.pinnedCamera as CameraNode | null) ?? null, [scene])

  const showGizmo = useCallback(() => {
    if (hiddenGizmo.current) hiddenGizmo.current.node.visible = true
    hiddenGizmo.current = null
  }, [])

  const restorePilot = useCallback(() => {
    showGizmo()
    const save = pilotSave.current
    pilotSave.current = null
    if (!save) return
    save.cam.setPosition(vec3.fromValues(save.pos[0], save.pos[1], save.pos[2]))
    save.cam.setQuaternion(quat.fromValues(save.rot[0], save.rot[1], save.rot[2], save.rot[3]))
    save.cam.camera.fov = save.fov
    save.cam.camera.up = vec3.fromValues(save.up[0], save.up[1], save.up[2])
  }, [showGizmo])

  /** Put the shot's view on the editor camera (saving the editor camera's own the first time). */
  const pilotTo = useCallback((shot: CameraNode | null) => {
    const cam = editorCamera()
    if (!cam || !shot || cam === shot) return
    if (!pilotSave.current) {
      pilotSave.current = {
        cam, pos: Array.from(cam.position), rot: Array.from(cam.quaternion), fov: cam.camera.fov, up: Array.from(cam.camera.up),
      }
    }
    const gizmo = shot.getChildByName(CAMERA_GIZMO)[0]
    if (gizmo && hiddenGizmo.current?.node !== gizmo) {
      showGizmo()
      gizmo.visible = false
      hiddenGizmo.current = { node: gizmo }
    }
    // The editor camera sits at the scene root, so the shot's world pose is its local one.
    cam.setPosition(vec3.clone(shot.worldPosition))
    cam.setQuaternion(quat.clone(shot.worldQuaternion))
    cam.camera.fov = shot.camera.fov
    cam.camera.up = vec3.clone(shot.camera.up)
  }, [editorCamera, showGizmo])

  const stopOn = useCallback((target: SequenceNode | null) => {
    wrap(() => {
      target?.stop()
      restorePilot()
    })
  }, [restorePilot, wrap])

  const stop = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    if (appliedOn.current) stopOn(appliedOn.current)
    appliedOn.current = null
    setApplied(false)
    unregister.current?.()
    unregister.current = null
  }, [stopOn])
  const stopRef = useRef(stop)
  stopRef.current = stop

  const apply = useCallback((t: number) => {
    const target = nodeRef.current
    if (!target) return
    wrap(() => {
      target.previewCuts = false
      target.seek(t)
      if (pilotRef.current) pilotTo(target.shotCamera as CameraNode | null)
    })
    if (appliedOn.current !== target) {
      appliedOn.current = target
      setApplied(true)
      unregister.current ??= registerSequencePreview(() => stopRef.current())
    }
  }, [pilotTo, wrap])

  const seek = useCallback((t: number) => {
    const d = nodeRef.current?.duration ?? 0
    const clamped = Math.min(d, Math.max(0, t))
    timeRef.current = clamped
    setTime(clamped)
    apply(clamped)
  }, [apply])

  // The node was replaced (an undo re-creates it from its snapshot) or another was chosen: hand back what the
  // old one changed, and pick the preview up again on the new one where it was.
  useEffect(() => {
    const previous = appliedOn.current
    if (previous && previous !== node) {
      stopOn(previous)
      appliedOn.current = null
      if (node && previous.id === node.id) apply(timeRef.current)
      else { playingRef.current = false; setPlaying(false); setApplied(false) }
    }
  }, [node, apply, stopOn])

  // The clock.
  useEffect(() => {
    if (!playing) return
    let raf = 0, last = performance.now(), lastRender = 0
    const tick = (now: number) => {
      const target = nodeRef.current
      if (!target || !playingRef.current) return
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      let t = timeRef.current + dt
      const d = target.duration
      if (t >= d) {
        if (loopRef.current && d > 0) t %= d
        else { t = d; playingRef.current = false; setPlaying(false) }
      }
      timeRef.current = t
      apply(t)
      if (now - lastRender > 66 || !playingRef.current) { lastRender = now; setTime(t) }
      if (playingRef.current) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, apply])

  // Unmount: the scene goes back as authored.
  useEffect(() => () => stopRef.current(), [])

  const play = useCallback(() => {
    const target = nodeRef.current
    if (!target) return
    if (timeRef.current >= target.duration - 1e-6) timeRef.current = 0
    playingRef.current = true
    setPlaying(true)
  }, [])
  const pause = useCallback(() => { playingRef.current = false; setPlaying(false); setTime(timeRef.current) }, [])
  const toggle = useCallback(() => { if (playingRef.current) pause(); else play() }, [pause, play])

  const setPilot = useCallback((on: boolean) => {
    pilotRef.current = on
    setPilotState(on)
    wrap(() => {
      if (!on) restorePilot()
      else if (appliedOn.current) pilotTo(appliedOn.current.shotCamera as CameraNode | null)
    })
  }, [pilotTo, restorePilot, wrap])

  const refresh = useCallback(() => { if (appliedOn.current) apply(timeRef.current) }, [apply])

  return { time, timeRef, playing, applied, pilot, loop, seek, play, pause, toggle, stop, setPilot, setLoop, refresh }
}
