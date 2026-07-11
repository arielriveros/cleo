import { useEffect, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { getAnimationTarget } from './skeleton'

// Floating bottom transport for the Animation Editor. The editor scene is paused (animators don't
// tick), so this component drives the target animator itself via requestAnimationFrame: it advances
// the clip while playing, scrubs on the progress bar, and can simulate the state machine (evaluating
// transitions from live parameter values) when one is authored.

export default function AnimationPlayer() {
  const { editorScene, animationTargetId, closeTab, activeTabId, eventEmitter } = useCleoEngine()

  const [clip, setClip] = useState<string>('')
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [simulate, setSimulate] = useState(false)

  const playingRef = useRef(false)
  const simulateRef = useRef(false)
  const lastRef = useRef(0)
  const scrubbingRef = useRef(false)
  const [, force] = useState(0)

  const target = getAnimationTarget(editorScene, animationTargetId)
  const clips = target ? target.model.animations.map(a => a.name) : []
  const hasStateMachine = !!target?.animator.hasStateMachine

  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { simulateRef.current = simulate }, [simulate])

  // Reflect a state machine applied in the right sidebar (so the Simulate toggle appears/updates).
  useEffect(() => {
    const onChanged = () => force(x => x + 1)
    eventEmitter.on('ANIM_SM_CHANGED', onChanged)
    return () => { eventEmitter.off('ANIM_SM_CHANGED', onChanged) }
  }, [eventEmitter])

  // On (re)entry, park on the first clip's first frame in bind pose.
  useEffect(() => {
    if (!target) return
    const first = target.model.animations[0]?.name ?? ''
    setClip(first)
    if (first) {
      target.animator.playAnimationByName(first, loop, false)
      target.animator.pause()
      target.animator.seek(0)
      setDuration(target.animator.duration)
    }
    target.animator.showBindPose()
    setPlaying(false)
    setTime(0)
    lastRef.current = performance.now()
    // Leave the model in bind pose when exiting the Animation Editor.
    return () => { target.animator.showBindPose() }
  }, [animationTargetId])

  // Per-frame drive loop.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const t = getAnimationTarget(editorScene, animationTargetId)
      if (t) {
        const now = performance.now()
        const dt = Math.min((now - lastRef.current) / 1000, 0.1)
        lastRef.current = now
        if (playingRef.current && !scrubbingRef.current) {
          if (simulateRef.current && t.animator.hasStateMachine) t.animator.checkTriggers()
          t.animator.update(dt)
          setTime(t.animator.currentTime)
          setDuration(t.animator.duration)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [editorScene, animationTargetId])

  if (!target) {
    return (
      <div data-cleo-overlay className='absolute bottom-3 left-1/2 -translate-x-1/2 z-20 bg-[#202020]/95 border border-[#2d2d77] rounded px-3 py-2 text-xs text-gray-400'>
        No skinned model selected — <button className='underline' onClick={() => closeTab(activeTabId)}>close</button>
      </div>
    )
  }

  const animator = target.animator

  const selectClip = (name: string) => {
    setClip(name)
    setSimulate(false)
    animator.playAnimationByName(name, loop, false)
    animator.pause()
    animator.seek(0)
    setDuration(animator.duration)
    setPlaying(false)
    setTime(0)
  }

  const onPlay = () => {
    if (simulate && hasStateMachine) {
      animator.resetStateMachine()
    } else if (clip && animator.currentAnimation?.name !== clip) {
      animator.playAnimationByName(clip, loop, false)
    } else {
      animator.play()
    }
    animator.loop = loop
    animator.speed = speed
    lastRef.current = performance.now()
    setPlaying(true)
  }
  const onPause = () => { animator.pause(); setPlaying(false) }
  const onStop = () => {
    animator.stop()
    animator.showBindPose()
    setPlaying(false)
    setTime(0)
  }
  const onScrub = (v: number) => {
    scrubbingRef.current = true
    if (clip && animator.currentAnimation?.name !== clip) animator.playAnimationByName(clip, loop, false)
    animator.pause()
    animator.seek(v)
    setTime(v)
    setPlaying(false)
    requestAnimationFrame(() => { scrubbingRef.current = false })
  }

  const btn = 'px-2 py-1 rounded bg-[#3b3b3b] hover:bg-[#4a4a4a] border border-[#555] text-white'
  const fmt = (s: number) => `${s.toFixed(2)}s`

  return (
    <div
      data-cleo-overlay
      className='absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex flex-col gap-2 bg-[#202020]/95 border border-[#2d2d77] rounded px-3 py-2 shadow-lg'
      style={{ minWidth: 520 }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className='flex items-center gap-2 text-xs text-white'>
        <select
          className='bg-[#3b3b3b] text-white border border-[#555] rounded px-2 py-1 max-w-[160px]'
          value={clip}
          onChange={(e) => selectClip(e.target.value)}
          title='Animation clip'>
          {clips.length === 0 && <option value=''>No clips</option>}
          {clips.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <button className={btn} title='Play' onClick={onPlay} disabled={playing}>▶</button>
        <button className={btn} title='Pause' onClick={onPause} disabled={!playing}>❚❚</button>
        <button className={btn} title='Stop (T-pose)' onClick={onStop}>■</button>

        <label className='flex items-center gap-1 ml-1' title='Loop'>
          <input type='checkbox' checked={loop} onChange={(e) => { setLoop(e.target.checked); animator.loop = e.target.checked }} />
          loop
        </label>
        <label className='flex items-center gap-1' title='Playback speed'>
          speed
          <input
            className='w-[52px] bg-[#3b3b3b] text-white border border-[#555] rounded px-1'
            type='number' step='0.1' min='0' value={speed}
            onChange={(e) => { const v = Math.max(0, parseFloat(e.target.value) || 0); setSpeed(v); animator.speed = v }} />
        </label>

        {hasStateMachine && (
          <label className='flex items-center gap-1 ml-1 text-[#8f8fff]' title='Play the state machine (evaluate transitions from parameters) instead of the raw clip'>
            <input type='checkbox' checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
            simulate
          </label>
        )}

        <button className={btn + ' ml-auto'} title='Close the Animation Editor tab' onClick={() => closeTab(activeTabId)}>Close</button>
      </div>

      <div className='flex items-center gap-2 text-[11px] text-gray-300'>
        <span className='tabular-nums w-[46px] text-right'>{fmt(time)}</span>
        <input
          className='flex-1'
          type='range' min={0} max={Math.max(duration, 0.0001)} step={0.001}
          value={Math.min(time, duration)}
          onChange={(e) => onScrub(parseFloat(e.target.value))} />
        <span className='tabular-nums w-[46px]'>{fmt(duration)}</span>
        {simulate && hasStateMachine && <span className='text-[#8f8fff]'>state: {animator.currentStateName ?? '—'}</span>}
      </div>
    </div>
  )
}
