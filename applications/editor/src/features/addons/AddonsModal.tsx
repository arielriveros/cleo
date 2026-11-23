import { Button, DocScope, Modal, ModalFooter, ModalHeader, Toggle } from '@cleo/app-kit/ui'
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'
import { openDocs } from '@cleo/app-kit/docs/viewer/docsViewerStore'
import { BookIcon, FlaskIcon } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../EngineContext'
import { BUILT_IN_ADDONS } from './registry'
import { addonOffPrompt, dependentsOf, missingRequirements, withAddon, withoutAddon } from './dependencies'
import type { AddonManifest } from './types'

// Project ▸ Addons: the editor addons this project turns on (Project Settings ▸ addons, so the choice travels
// with the project). A change applies at once: AddonHost loads or stops the addon.

export default function AddonsModal({ onClose }: { onClose: () => void }) {
  const { projectSettings, setProjectSettings } = useCleoEngine()
  const enabled = projectSettings.addons.enabled

  const set = async (addon: AddonManifest, on: boolean) => {
    // Turning one off turns off what runs on it: say so, with what each of them ends.
    const prompt = on ? null : addonOffPrompt(addon, dependentsOf(addon.id).filter(d => enabled.includes(d.id)))
    if (prompt && !await confirmDialog({
      title: `Turn ${addon.name} off?`, message: prompt, confirmLabel: 'Turn off', tone: 'warning',
    })) return
    setProjectSettings(prev => ({
      ...prev,
      addons: { ...prev.addons, enabled: on ? withAddon(prev.addons.enabled, addon.id) : withoutAddon(prev.addons.enabled, addon.id) },
    }))
  }

  return (
    <Modal onClose={onClose} className='w-[520px] max-w-[95vw]'>
      <DocScope page='editor/addons'>
        <ModalHeader title='Addons' doc='editor/addons#built-in-addons' />
        <div className='px-4 py-3 flex flex-col gap-3'>
          {BUILT_IN_ADDONS.map(addon => {
            // An addon whose requirement is off is off, and cannot be turned on until that one is.
            const missing = missingRequirements(addon.id, enabled)
            const on = enabled.includes(addon.id) && missing.length === 0
            return (
              <div key={addon.id} className='flex items-start gap-3 min-w-0'>
                <Toggle checked={on} disabled={missing.length > 0} onChange={next => void set(addon, next)} doc={false}
                  title={missing.length > 0 ? `Needs the ${missing.map(m => m.name).join(' and ')} addon`
                    : on ? `Turn ${addon.name} off for this project` : `Turn ${addon.name} on for this project`} />
                <div className='flex-1 min-w-0'>
                  <div className='flex items-baseline gap-2'>
                    <span className='text-ui font-semibold text-fg'>{addon.name}</span>
                    <span className='text-ui-xs text-dim'>{addon.version} · {addon.author}</span>
                    {addon.experimental && (
                      <span className='inline-flex items-center gap-0.5 text-ui-xs rounded px-1 shrink-0 bg-warning/15 text-warning'
                        title='Experimental: it works, but may change in a later version.'>
                        <span className='inline-flex w-3 h-3'><FlaskIcon /></span>Experimental
                      </span>
                    )}
                  </div>
                  <div className='text-ui-sm text-muted'>{addon.description}</div>
                  {missing.length > 0 && <div className='text-ui-xs text-dim'>Needs the {missing.map(m => m.name).join(' and ')} addon.</div>}
                </div>
                <Button size='sm' variant='ghost' title={`Open the ${addon.name} documentation`} aria-label={`${addon.name} documentation`}
                  onClick={() => openDocs({ page: addon.docPage })}>
                  <span className='inline-block w-3.5 h-3.5'><BookIcon /></span>
                </Button>
              </div>
            )
          })}
        </div>
        <ModalFooter>
          <Button onClick={onClose}>Close</Button>
        </ModalFooter>
      </DocScope>
    </Modal>
  )
}
