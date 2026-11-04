import { buttonVariants, cn, useDocEntry, useDocTooltip } from '@cleo/app-kit/ui'

// The Creator's logo, a copy the editor serves itself (tools/brandIcons.mjs): /creator/brand/ goes through
// the dev server's proxy, which has no image to give while the Creator is not running.
const CREATOR_ICON = `${import.meta.env.BASE_URL}brand/creator-32.png`

/**
 * "Creator", beside Import: opens Cleo Creator. Same origin (/creator/), so what it saves reaches this
 * project through the shared Creator library, under /Creator; one named window, reused by every click.
 */
export default function CreatorButton() {
  const entry = useDocEntry(undefined, 'editor/assets#the-panel::Creator')
  const tip = useDocTooltip(entry)
  return (
    <>
      <button type='button' ref={tip.ref} {...tip.hoverProps} aria-describedby={tip.describedBy}
        title={entry ? undefined : 'Open Cleo Creator; its saved assets appear under /Creator'}
        className={cn(buttonVariants({ variant: 'default', size: 'sm' }),
          'shrink-0 gap-1 h-[20px] text-ui-sm leading-none whitespace-nowrap')}
        onClick={() => window.open('/creator/', 'cleo-creator')?.focus()}>
        <img src={CREATOR_ICON} className='w-3 h-3' alt='' draggable={false} />Creator
      </button>
      {tip.card}
    </>
  )
}
