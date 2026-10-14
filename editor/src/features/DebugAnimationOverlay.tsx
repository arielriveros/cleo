import { useEffect, useState } from 'react'
import { ModelNode } from 'cleo'
import type { Animator } from 'cleo'
import { useCleoEngine } from './EngineContext'
import { usePlayback } from './PlaybackContext'
import { useDebugVisibility } from './DebugVisibilityContext'
import FieldDebugReadout from './animation/FieldDebugReadout'
import { Select } from '../components/ui'

// The animation blend readout, in the VIEWPORT. The State Machine inspector shows the same numbers, but it
// runs against the editor's preview scene, which has no physics, so every MEASURED built-in reads 0 there.
// Reads instance.scene, so one component serves both channels of the `animation` toggle. A DOM overlay.

/** Animators in the live scene, with a label to pick between them. Rebuilt on demand, not per frame. */
function animatorsIn(scene: any): { id: string; name: string; animator: Animator }[] {
  const out: { id: string; name: string; animator: Animator }[] = []
  if (!scene) return out
  for (const node of scene.nodes) {
    if (!(node instanceof ModelNode) || !node.animator) continue
    out.push({ id: node.id, name: node.name, animator: node.animator })
  }
  return out
}

export default function DebugAnimationOverlay() {
  const { instance, editorMode } = useCleoEngine()
  const { isPlayMode } = usePlayback()
  const { visibility } = useDebugVisibility()

  const active = isPlayMode ? visibility.animation.runtime : visibility.animation.editor

  const [targets, setTargets] = useState<{ id: string; name: string; animator: Animator }[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // The play scene is a throwaway rebuilt on every entry, so the animator objects are replaced wholesale.
  // Re-scan on a slow interval rather than once: a character can also be spawned partway through a session.
  useEffect(() => {
    if (!instance || !active) { setTargets([]); return }
    const scan = () => setTargets(animatorsIn(instance.scene))
    scan()
    const h = window.setInterval(scan, 1000)
    return () => window.clearInterval(h)
  }, [instance, active, isPlayMode, editorMode])

  if (!active) return null

  // Default to the first animator, and fall back to it whenever the selected one goes away with the scene.
  const current = targets.find(t => t.id === selectedId) ?? targets[0] ?? null

  return (
    <div data-cleo-overlay
      className='absolute bottom-2 right-2 z-20 w-64 select-none rounded-md border border-control bg-surface-raised/95 p-2 text-fg shadow-lg'>
      <div className='mb-1 flex items-center gap-1'>
        <span className='text-ui-xs font-medium text-muted'>Animation blend</span>
        {targets.length > 1 && (
          <Select
            className='ml-auto min-w-0 flex-1 px-1 py-0.5 text-ui-xs'
            value={current?.id ?? ''} onChange={e => setSelectedId(e.target.value)}>
            {targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
        {targets.length === 1 && <span className='ml-auto truncate text-ui-xs text-dim'>{current?.name}</span>}
      </div>

      {!current
        ? <p className='text-ui-xs text-dim'>
            No animated model in the {isPlayMode ? 'play' : 'editor'} scene.
          </p>
        : <FieldDebugReadout animator={current.animator} />}

      {!isPlayMode && (
        <p className='mt-1 border-t border-control pt-1 text-ui-xs text-dim'>
          Editor has no physics — measured inputs (speed, angle) read 0 here. Enter Play for real values.
        </p>
      )}
    </div>
  )
}
