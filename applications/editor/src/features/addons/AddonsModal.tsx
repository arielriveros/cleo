import { Button, DocScope, Modal, ModalFooter, ModalHeader, Toggle } from '@cleo/app-kit/ui'
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'
import { openDocs } from '@cleo/app-kit/docs/viewer/docsViewerStore'
import { BookIcon } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../EngineContext'
import { BUILT_IN_ADDONS } from './registry'
import type { AddonManifest } from './types'

// Project ▸ Addons: the editor addons this project turns on (Project Settings ▸ addons, so the choice travels
// with the project). A change applies at once: AddonHost loads or stops the addon.

export default function AddonsModal({ onClose }: { onClose: () => void }) {
  const { projectSettings, setProjectSettings } = useCleoEngine()
  const enabled = projectSettings.addons.enabled

  const set = async (addon: AddonManifest, on: boolean) => {
    if (!on && addon.confirmDisable && !await confirmDialog({
      title: `Turn ${addon.name} off?`, message: addon.confirmDisable, confirmLabel: 'Turn off', tone: 'warning',
    })) return
    setProjectSettings(prev => {
      const list = prev.addons.enabled.filter(id => id !== addon.id)
      return { ...prev, addons: { ...prev.addons, enabled: on ? [...list, addon.id] : list } }
    })
  }

  return (
    <Modal onClose={onClose} className='w-[520px] max-w-[95vw]'>
      <DocScope page='editor/addons'>
        <ModalHeader title='Addons' doc='editor/addons#built-in-addons' />
        <div className='px-4 py-3 flex flex-col gap-3'>
          {BUILT_IN_ADDONS.map(addon => (
            <div key={addon.id} className='flex items-start gap-3 min-w-0'>
              <Toggle checked={enabled.includes(addon.id)} onChange={on => void set(addon, on)} doc={false}
                title={enabled.includes(addon.id) ? `Turn ${addon.name} off for this project` : `Turn ${addon.name} on for this project`} />
              <div className='flex-1 min-w-0'>
                <div className='flex items-baseline gap-2'>
                  <span className='text-ui font-semibold text-fg'>{addon.name}</span>
                  <span className='text-ui-xs text-dim'>{addon.version} · {addon.author}</span>
                </div>
                <div className='text-ui-sm text-muted'>{addon.description}</div>
              </div>
              <Button size='sm' variant='ghost' title={`Open the ${addon.name} documentation`} aria-label={`${addon.name} documentation`}
                onClick={() => openDocs({ page: addon.docPage })}>
                <span className='inline-block w-3.5 h-3.5'><BookIcon /></span>
              </Button>
            </div>
          ))}
        </div>
        <ModalFooter>
          <Button onClick={onClose}>Close</Button>
        </ModalFooter>
      </DocScope>
    </Modal>
  )
}
