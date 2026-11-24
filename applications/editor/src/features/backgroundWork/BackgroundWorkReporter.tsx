import { useEffect, useRef } from 'react'
import { shaderActivity } from 'cleo'
import { currentLoad } from '@cleo/app-kit/feedback/loadingStore'
import { useCleoEngine } from '../EngineContext'
import { DelayedTask } from './delayedTask'
import { shaderRows } from './shaderTask'
import { giRows, probeRows } from './bakeRows'

// Puts the work the engine does on its own into the editor's progress popup (app-kit ProgressWindow), beside the
// imports, saves and bakes the editor runs itself:
// - "Compiling shaders": pipelines built off the main thread (a material, the water, a screen effect that shows
//   up a while after it is first seen) and the warm-up of the pipelines the project used last session;
// - "Capturing GI": GI volumes whose probes are still being drawn;
// - "Baking light probes": the probe job in flight (a capture, a relight after a light changed, a filter).
// Polled rather than pushed: the engine runs these a slice per render frame, and a quarter of a second is plenty
// for a progress bar. Renders nothing; mounted beside ProgressWindow (Editor.tsx), so it runs in Play too.
//
// While a loading screen counts the shaders (its "Compiling shaders" step: a project or a scene opening), the card
// stays away: the step's count is the same builds, and two progresses for one job read as two jobs.

const POLL_MS = 250

/** Whether the load on screen is counting the shaders being built (its shaders step is running). */
function loadCountsShaders(): boolean {
  return !!currentLoad()?.steps.some(s => s.id === 'shaders' && s.status === 'running')
}

export default function BackgroundWorkReporter() {
  const { instance, materials } = useCleoEngine()
  const instanceRef = useRef(instance)
  instanceRef.current = instance
  const materialsRef = useRef(materials)
  materialsRef.current = materials

  useEffect(() => {
    const shaders = new DelayedTask({ title: 'Compiling shaders', indeterminate: true })
    const gi = new DelayedTask({ title: 'Capturing GI' })
    const probes = new DelayedTask({ title: 'Baking light probes' })
    const poll = () => {
      shaders.update(loadCountsShaders() ? [] : shaderRows(shaderActivity.snapshot(), materialsRef.current, performance.now()))
      const renderer = instanceRef.current?.renderer
      gi.update(renderer?.gi ? giRows(renderer.gi.describe()) : [])
      probes.update(renderer ? probeRows(renderer.probeBakeProgress) : [])
    }
    const id = window.setInterval(poll, POLL_MS)
    return () => {
      window.clearInterval(id)
      shaders.close()
      gi.close()
      probes.close()
    }
  }, [])

  return null
}
