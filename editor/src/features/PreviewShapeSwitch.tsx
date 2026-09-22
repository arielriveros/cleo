import { useEffect, useState } from 'react'
import { SegmentedControl } from '../components/ui'
import { useCleoEngine } from './EngineContext'
import { PREVIEW_SHAPES, loadPreviewShape, type PreviewKind, type PreviewShape } from './demoScene/previewShapes'

// The material previews' shape switch: sphere / plane, plus hill for a landscape material. Sits in the
// viewport's top-right chrome, which the material modes otherwise leave empty. A landscape material also
// gets a one-line legend saying what the preview's height stands for, since its elevation rules are
// judged against a remapped span rather than the few metres the subject really is.

const LABELS: Record<PreviewShape, { label: string; title: string }> = {
  sphere: { label: 'Sphere', title: 'Every angle a surface can face: flat on top, vertical at the equator' },
  plane: { label: 'Plane', title: 'How the material tiles on flat ground' },
  hill: { label: 'Hill', title: 'Real slopes and elevation, so slope and elevation rules show as they will on a landscape' },
}

export default function PreviewShapeSwitch({ kind }: { kind: PreviewKind }) {
  const { setPreviewShape, previewElevationLegend, eventEmitter } = useCleoEngine()
  const [shape, setShape] = useState<PreviewShape>(() => loadPreviewShape(kind))
  const [legend, setLegend] = useState<string | null>(null)

  // Re-read after any edit: a rule change can move the span the legend describes.
  useEffect(() => {
    const refresh = () => setLegend(kind === 'terrainMaterial' ? previewElevationLegend() : null)
    refresh()
    eventEmitter.on('SCENE_CHANGED', refresh)
    return () => { eventEmitter.off('SCENE_CHANGED', refresh) }
  }, [kind, shape, eventEmitter, previewElevationLegend])

  useEffect(() => { setShape(loadPreviewShape(kind)) }, [kind])

  return (
    <div className='flex flex-col items-end gap-1'>
      <SegmentedControl<PreviewShape> size='sm'
        options={PREVIEW_SHAPES[kind].map(s => ({ value: s, label: LABELS[s].label, title: LABELS[s].title }))}
        value={shape}
        onChange={s => { setShape(s); setPreviewShape(s) }} />
      {legend && <span className='text-[10px] text-white/80 bg-black/40 rounded px-1.5 py-0.5'>{legend}</span>}
    </div>
  )
}
