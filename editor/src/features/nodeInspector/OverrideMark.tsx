import { Button } from '../../components/ui'

// Beside a value a placed template instance overrides: says so, and puts the template's value back.
export default function OverrideMark(props: { onRevert: () => void; title?: string }) {
  return (
    <Button
      variant='ghost'
      size='sm'
      className='shrink-0 gap-1 px-1 py-0 text-ui-xs leading-4 font-normal text-primary hover:text-primary bg-primary/15 hover:bg-primary/25'
      title={props.title ?? "Overridden on this instance. Click to revert to the template's value."}
      onClick={props.onRevert}
    >
      <span className='inline-block w-1.5 h-1.5 rounded-full bg-primary' />
      revert
    </Button>
  )
}
