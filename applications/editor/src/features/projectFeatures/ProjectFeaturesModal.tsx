import { useCallback, useEffect, useState } from 'react'
import { enabledFeatures, featureById, Logger } from 'cleo'
import { Button, DocScope, Modal, ModalFooter, ModalHeader } from '@cleo/app-kit/ui'
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'
import { useCleoEngine } from '../EngineContext'
import type { FeatureUsage } from '../publish/featureUsage'
import FeaturePicker, { type FeatureChoice } from './FeaturePicker'
import { detectProjectUsage, detectedDisabled } from './detect'
import { useFeatureSizes } from './featureSizes'

// Project ▸ Features: which of the engine's optional features this project's games ship (the engine's
// src/modules/catalog.ts). The editor hides what is off; publishing strips it. Changes apply on Apply.

export default function ProjectFeaturesModal({ onClose }: { onClose: () => void }) {
  const {
    instance, projectSettings, setProjectSettings, editorScene, openSceneId, sceneList, templates, materials, scriptAssets, sceneDimension,
  } = useCleoEngine()
  const [choice, setChoice] = useState<FeatureChoice>(() => ({
    disabled: projectSettings.features.disabled.filter((id: string) => id !== 'webgl2'),
    webgl2: projectSettings.publish.webgl2Fallback,
  }))
  const [usage, setUsage] = useState<FeatureUsage | null>(null)
  const [scanning, setScanning] = useState(false)
  const sizes = useFeatureSizes()

  const scan = useCallback(async (): Promise<FeatureUsage | null> => {
    setScanning(true)
    try {
      const found = await detectProjectUsage({
        liveScene: editorScene, openSceneId, scenes: sceneList, liveSettings: instance?.renderer.getRenderSettings(), liveDimension: sceneDimension,
        templates: templates ?? [], materials, scriptAssets: scriptAssets ?? [],
      })
      setUsage(found)
      return found
    } catch (e) {
      Logger.warn(`Could not read what the project uses: ${e}`, 'Features')
      return null
    } finally {
      setScanning(false)
    }
  }, [editorScene, openSceneId, sceneList, templates, materials, scriptAssets, instance, sceneDimension])

  useEffect(() => { void scan() }, [])

  const detect = async () => {
    const found = usage ?? await scan()
    if (found) setChoice(c => ({ ...c, disabled: detectedDisabled(found, c.disabled) }))
  }

  const apply = async () => {
    const on = enabledFeatures(choice.disabled)
    const stranded = [...(usage ?? new Map()).entries()].filter(([id, uses]) => !on.has(id) && uses.length)
    if (stranded.length) {
      const ok = await confirmDialog({
        title: 'Leave out features the project uses?',
        message: 'These stay in the project, and Publish asks about them again. A published game leaves them out.',
        details: stranded.map(([id, uses]) => `${featureById(id)?.label ?? id}: ${uses.length} ${uses.length === 1 ? 'use' : 'uses'} (${uses[0].where})`),
        confirmLabel: 'Leave them out',
        tone: 'warning',
      })
      if (!ok) return
    }
    setProjectSettings(prev => ({
      ...prev,
      features: { ...prev.features, disabled: [...choice.disabled].sort() },
      publish: { ...prev.publish, webgl2Fallback: choice.webgl2 },
    }))
    onClose()
  }

  return (
    <Modal onClose={onClose} className='w-[860px] max-w-[95vw]'>
      <DocScope page='editor/project-features'>
        <ModalHeader title='Project features' doc='editor/project-features#what-turning-a-feature-off-does' aside={scanning ? 'Reading the project…' : undefined} />
        <div className='px-4 py-3'>
          <FeaturePicker value={choice} onChange={setChoice} usage={usage} sizes={sizes}
            physicsBackend={projectSettings.engine.physicsBackend} />
        </div>
        <ModalFooter className='justify-between'>
          <Button size='sm' variant='ghost' disabled={scanning} onClick={() => void detect()}
            title='Turn on what the project uses and off what it does not, from its scenes, templates and scripts. A feature a script reaches only by building it at runtime is not seen.'>
            Detect from project
          </Button>
          <div className='flex gap-2'>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant='primary' className='font-semibold' onClick={() => void apply()}>Apply</Button>
          </div>
        </ModalFooter>
      </DocScope>
    </Modal>
  )
}
