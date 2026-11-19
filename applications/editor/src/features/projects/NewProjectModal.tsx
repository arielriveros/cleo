import { useState } from 'react'
import { Logger, presetMatching, FEATURE_PRESETS } from 'cleo'
import { Button, DocScope, Modal, ModalFooter, ModalHeader, SectionTitle, TextInput, Toggle } from '@cleo/app-kit/ui'
import { createProject } from '../../utils/projects'
import { openProject } from './projectSwitch'
import { DEFAULT_PROJECT_SETTINGS, parseProjectSettings, PROJECT_SETTINGS_VERSION } from '../options/projectSettings'
import FeaturePicker, { presetChoice, type FeatureChoice } from '../projectFeatures/FeaturePicker'
import { useFeatureSizes } from '../projectFeatures/featureSizes'
import { BUILT_IN_ADDONS } from '../addons/registry'
import { missingRequirements, withAddon, withoutAddon } from '../addons/dependencies'

// The new-project dialog: a name, the engine features its games ship (a preset to start from, every box
// changeable here and later in Project ▸ Features) and the editor addons it turns on. Creating switches to it.

export default function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const [name, setName] = useState('')
  const [choice, setChoice] = useState<FeatureChoice>(() => presetChoice(FEATURE_PRESETS.find(p => p.id === 'everything')!))
  const [addons, setAddons] = useState<string[]>(() => BUILT_IN_ADDONS.filter(a => a.defaultOn).map(a => a.id))
  const [busy, setBusy] = useState(false)
  const sizes = useFeatureSizes()

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const settings = parseProjectSettings({
        ...DEFAULT_PROJECT_SETTINGS,
        version: PROJECT_SETTINGS_VERSION,
        publish: { ...DEFAULT_PROJECT_SETTINGS.publish, webgl2Fallback: choice.webgl2 },
        features: { disabled: choice.disabled },
        addons: { enabled: addons, settings: {} },
      })
      // The first scene takes the preset's dimension: a 2D project opens on a 2D scene.
      const dimension = presetMatching(choice.disabled)?.dimension ?? (choice.disabled.includes('world2d') ? '3D' : undefined)
      const record = await createProject(trimmed, { settings, dimension })
      onCreated?.()
      // A declined confirm (unsaved work in the open project) leaves the new project created, not switched to.
      if (!await openProject(record.id)) { setBusy(false); onClose() }
    } catch (e) {
      setBusy(false)
      Logger.error(`Could not create the project: ${e}`, 'Editor')
    }
  }

  return (
    <Modal onClose={busy ? () => {} : onClose} className='w-[620px] max-w-[95vw]' overlayClassName='z-[60]'>
      <DocScope page='editor/project-features'>
        <ModalHeader title='New project' doc='editor/project-features#new-projects' />
        <div className='px-4 py-3 flex flex-col gap-3'>
          <TextInput autoFocus placeholder='Project name' value={name} onChange={setName} maxLength={120}
            onKeyDown={e => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') onClose() }} />
          <FeaturePicker value={choice} onChange={setChoice} sizes={sizes} compact />
          <div className='flex flex-col gap-1'>
            <SectionTitle title='Addons' doc='editor/addons' />
            {BUILT_IN_ADDONS.map(a => {
              // One whose requirement is off is off too, and greyed until that one is on (addons/dependencies.ts).
              const missing = missingRequirements(a.id, addons)
              return (
                <div key={a.id} className='flex items-start gap-2'>
                  <Toggle checked={addons.includes(a.id) && missing.length === 0} disabled={missing.length > 0} doc={false}
                    title={missing.length > 0 ? `Needs the ${missing.map(m => m.name).join(' and ')} addon` : a.description}
                    onChange={on => setAddons(list => on ? withAddon(list, a.id) : withoutAddon(list, a.id))} />
                  <div className='min-w-0'>
                    <div className='text-ui text-fg'>{a.name}</div>
                    <div className='text-ui-xs text-muted'>{a.description}</div>
                    {missing.length > 0 && <div className='text-ui-xs text-dim'>Needs the {missing.map(m => m.name).join(' and ')} addon.</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <ModalFooter>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant='success' className='font-semibold' disabled={!name.trim() || busy} onClick={() => void create()}>
            Create
          </Button>
        </ModalFooter>
      </DocScope>
    </Modal>
  )
}
