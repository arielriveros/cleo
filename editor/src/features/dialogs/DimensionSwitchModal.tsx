import { useProject } from '../ProjectContext'
import { Modal, ModalHeader, ModalFooter } from '../../components/ui'

// Shown when a scene is switched between 2D and 3D while it still holds the OTHER dimension's authoring:
// a landscape in a scene going 2D, or a tilemap in one going 3D. `setSceneDimension` parks a promise
// (confirmDimensionSwitch) and this resolves it.
//
// The point is that the loss is deferred, not immediate: nothing is deleted, the switch is reversible, and
// the data survives every save and project export. It is only a PUBLISHED build that drops it — which is
// exactly the moment it would be too late to mention. Mounted globally in Editor.
export default function DimensionSwitchModal() {
  const { pendingDimensionConfirm, resolveDimensionConfirm } = useProject()

  if (!pendingDimensionConfirm) return null
  const { to, losing, count } = pendingDimensionConfirm
  const noun = losing === 'tilemap'
    ? (count === 1 ? 'tilemap' : 'tilemaps')
    : (count === 1 ? 'landscape' : 'landscapes')

  return (
    <Modal onClose={() => resolveDimensionConfirm(false)} className='w-[440px]'>
      <ModalHeader>
        <div className='text-sm font-semibold'>Switch this scene to {to}?</div>
      </ModalHeader>

      <div className='px-4 py-3 text-sm text-gray-300 space-y-2'>
        <p>
          This scene contains <span className='font-semibold text-white'>{count} {noun}</span>, which
          a {to} scene does not use. {count === 1 ? 'It' : 'They'} will stop rendering and stop colliding.
        </p>
        <p>
          Nothing is deleted — switch back to {to === '2D' ? '3D' : '2D'} and {count === 1 ? 'it comes' : 'they come'} straight
          back, and {count === 1 ? 'it is' : 'they are'} kept in project saves and exports.
        </p>
        <p className='text-warning'>
          Publishing is the exception: a published build discards the unused {noun} so {count === 1 ? 'it does' : 'they do'} not
          take up space in the shipped game.
        </p>
      </div>

      <ModalFooter>
        <button
          className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover'
          onClick={() => resolveDimensionConfirm(false)}
        >
          Cancel
        </button>
        <button
          className='px-3 py-1.5 text-xs rounded bg-primary hover:bg-primary-hover font-semibold'
          onClick={() => resolveDimensionConfirm(true)}
        >
          Switch to {to}
        </button>
      </ModalFooter>
    </Modal>
  )
}
