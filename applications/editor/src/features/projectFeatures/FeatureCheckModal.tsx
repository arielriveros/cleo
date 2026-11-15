import { featureById } from 'cleo'
import { Button, DocScope, Modal, ModalFooter, ModalHeader } from '@cleo/app-kit/ui'
import type { FeatureUsage } from '../publish/featureUsage'

// Asked by Publish when the game uses features the project leaves out (Project ▸ Features): turn them back on
// for good, publish without them (their nodes are dropped from the build, nothing in the project changes), or
// stop. buildMultiSceneGameData waits on the answer (onDisabledFeatureUse).

export interface FeatureCheckProps {
  uses: FeatureUsage;
  /** The features to turn back on, none to publish without them, or null to stop. */
  onAnswer: (enable: string[] | null) => void;
}

const SHOWN = 6

export default function FeatureCheckModal({ uses, onAnswer }: FeatureCheckProps) {
  const ids = [...uses.keys()]
  return (
    <Modal onClose={() => onAnswer(null)} className='w-[560px]'>
      <DocScope page='editor/project-features'>
        <ModalHeader title='Features left out of this game' doc='editor/project-features#publishing' />
        <div className='px-4 py-3 text-ui flex flex-col gap-3 max-h-[55vh] overflow-y-auto'>
          <p className='text-fg'>
            The project leaves {ids.length === 1 ? 'this feature' : 'these features'} out of its games, and the game
            still uses {ids.length === 1 ? 'it' : 'them'}. Without {ids.length === 1 ? 'it' : 'them'}, the build drops
            what uses {ids.length === 1 ? 'it' : 'them'}: nodes are removed, settings turned off.
          </p>
          {ids.map(id => {
            const list = uses.get(id) ?? []
            return (
              <div key={id} className='flex flex-col gap-0.5'>
                <div className='font-semibold text-fg'>{featureById(id)?.label ?? id}</div>
                <ul className='text-ui-sm text-muted pl-3 list-disc'>
                  {list.slice(0, SHOWN).map((u, i) => <li key={i}><span className='text-fg'>{u.where}</span>: {u.what}</li>)}
                  {list.length > SHOWN && <li>… and {list.length - SHOWN} more</li>}
                </ul>
              </div>
            )
          })}
        </div>
        <ModalFooter>
          <Button onClick={() => onAnswer(null)}>Cancel</Button>
          <Button onClick={() => onAnswer([])} title='Publish this build without them. The project keeps everything as it is.'>
            Publish without them
          </Button>
          <Button variant='primary' className='font-semibold' onClick={() => onAnswer(ids)}
            title='Turn them back on in Project ▸ Features, and publish with them'>
            Turn {ids.length === 1 ? 'it' : 'them'} on and publish
          </Button>
        </ModalFooter>
      </DocScope>
    </Modal>
  )
}
