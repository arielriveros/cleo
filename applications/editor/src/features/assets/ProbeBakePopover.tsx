import { describeLightChanges, type StaleProbe } from 'cleo'
import { Button, Panel, cn, hintClass, valueClass, SectionTitle } from '@cleo/app-kit/ui'
import { rebakeStale } from '../../utils/probeBake'

/**
 * The light probes whose bake no longer matches the lights they captured (utils/probeBake.ts): each probe,
 * what changed, a row to select it, and one button that relights them all. Opened from the Asset
 * Explorer's toolbar, whose badge counts them.
 */
export default function ProbeBakePopover(
  { stale, onSelect, onClose }: { stale: StaleProbe[]; onSelect: (nodeId: string) => void; onClose: () => void },
) {
  const rebakeAll = () => {
    rebakeStale(stale)
    onClose()
  }

  return (
    <Panel className='absolute right-0 top-[22px] z-30 w-[320px] rounded shadow-lg'>
      <div className='px-3 py-2 border-b border-border flex items-center justify-between gap-2'>
        <SectionTitle title='Light probe bakes' doc='editor/node-inspector#light-probe' />
        <Button variant='remove' size='sm' className='leading-none px-1' title='Close' onClick={onClose}>✕</Button>
      </div>

      {stale.length === 0 ? (
        <div className={cn(hintClass, 'px-3 py-3')}>
          Every light probe matches the lights it baked.
        </div>
      ) : (
        <>
          <div className='max-h-[260px] overflow-y-auto'>
            {stale.map(s => (
              <button key={s.probe.id} type='button'
                className='w-full text-left flex flex-col gap-0.5 px-3 py-1.5 border-b border-border-subtle last:border-b-0 hover:bg-hover'
                title='Select the probe' onClick={() => onSelect(s.probe.id)}>
                <div className={cn(valueClass, 'truncate')}>{s.probe.name}</div>
                {s.lights.slice(0, 4).map(l => (
                  <div key={l.id} className={cn(hintClass, 'truncate')}>
                    {l.name || 'A deleted light'} · {describeLightChanges(l.what)}
                  </div>
                ))}
                {s.lights.length > 4 && <div className={hintClass}>and {s.lights.length - 4} more</div>}
              </button>
            ))}
          </div>
          <div className='px-3 py-2 border-t border-border flex items-center justify-between gap-2'>
            <span className={hintClass}>Relit a few frames each, no geometry redrawn</span>
            <Button variant='primary' size='sm' onClick={rebakeAll}>Re-bake all</Button>
          </div>
        </>
      )}
    </Panel>
  )
}
