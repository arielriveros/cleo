// Beside a value a placed template instance overrides: says so, and puts the template's value back.
export default function OverrideMark(props: { onRevert: () => void }) {
  return (
    <button
      type='button'
      className='shrink-0 inline-flex items-center gap-1 px-1 text-[10px] leading-4 rounded text-primary bg-primary/15 hover:bg-primary/25'
      title="Overridden on this instance. Click to revert to the template's value."
      onClick={props.onRevert}
    >
      <span className='inline-block w-1.5 h-1.5 rounded-full bg-primary' />
      revert
    </button>
  )
}
