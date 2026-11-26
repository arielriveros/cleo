import { useState } from 'react'
import { Logger, assetGraph, assetKey } from 'cleo'
import { Button, Field, TextInput, cn } from '@cleo/app-kit/ui'
import { OPTION_LABEL } from '@cleo/app-kit/ui/OptionsShell'
import { startTask } from '@cleo/app-kit/feedback/progressStore'
import { toast } from '@cleo/app-kit/feedback/toastStore'
import { useCleoEngine } from '../EngineContext'
import { useVfs } from '../assets/VfsContext'
import { useEventBus } from '../EventBusContext'
import TextureSlotPicker from '../texture/TextureSlotPicker'
import { CameraIcon } from '../nodeInspector/sectionIcons'
import { SpinnerIcon } from '../topbarIcons'
import { awaitTextureImage } from '../../utils/textureReady'
import {
  cleanAppId, cleanGameVersion, resolveAppId, type ProjectIdentitySettings,
} from './projectSettings'
import {
  COVER_HEIGHT, COVER_WIDTH, captureCover, coverCaptureBlocked, removeCapturedCover,
} from './coverCapture'

// Options ▸ Project ▸ Published game: who the game is. Its version, its app id, its icon and the project's
// cover (projectSettings.ts `ProjectIdentitySettings`). The explanations are docs/editor/options.md's rows.

export default function GameIdentityRows({ projectName }: { projectName: string }) {
  const {
    projectSettings, setProjectSettings, instance, mainScene, isPlayMode, textures, removeTextureAsset, removeImage,
  } = useCleoEngine()
  const { setVfs } = useVfs()
  const eventEmitter = useEventBus()
  const identity = projectSettings.identity
  const setIdentity = (patch: Partial<ProjectIdentitySettings>) =>
    setProjectSettings(prev => ({ ...prev, identity: { ...prev.identity, ...patch } }))

  // Typed freely and committed on blur: half a version ("1.") or half an id ("com.") is not one yet.
  const [version, setVersion] = useState<string | null>(null)
  const [appId, setAppId] = useState<string | null>(null)
  const commitVersion = () => {
    if (version === null) return
    const clean = cleanGameVersion(version)
    if (clean) setIdentity({ version: clean })
    else toast.warning(`"${version}" is not a version: use three numbers, like 1.2.0 (or 1.2.0-beta.1).`)
    setVersion(null)
  }
  const commitAppId = () => {
    if (appId === null) return
    const typed = appId.trim()
    const clean = cleanAppId(typed)
    // Emptied: back to the one its installers had (frozen again at the next publish).
    if (!typed) setIdentity({ appId: '' })
    else if (clean) setIdentity({ appId: clean })
    else toast.warning(`"${typed}" is not an app id: use reverse-DNS, like com.studio.game.`)
    setAppId(null)
  }

  const [capturing, setCapturing] = useState(false)
  const blocked = coverCaptureBlocked({ engine: instance, scene: mainScene, isPlayMode })

  const capture = async () => {
    if (!instance || capturing) return
    const why = coverCaptureBlocked({ engine: instance, scene: mainScene, isPlayMode })
    if (why) { toast.warning(why); return }
    const abort = new AbortController()
    const task = startTask({ title: 'Capturing the cover', steps: ['Rendering'], cancellable: true, onCancel: () => abort.abort() })
    setCapturing(true)
    try {
      task.setStep(0, { status: 'running', detail: 'Converging lighting' })
      const previous = identity.cover
      const id = await captureCover({
        engine: instance, scene: mainScene, setVfs, emit: (event) => eventEmitter.emit(event as any),
        signal: abort.signal, onProgress: detail => task.setStep(0, { status: 'running', detail }),
      })
      await awaitTextureImage(id)
      setIdentity({ cover: id })
      if (previous && previous !== id) {
        removeCapturedCover(previous, {
          textures, setVfs, removeTextureAsset, removeImage, emit: (event) => eventEmitter.emit(event as any),
          isUsedElsewhere: (tex) => [...assetGraph.incoming(assetKey('texture', tex))].length > 0,
        })
      }
      task.setStep(0, { status: 'done', detail: `${COVER_WIDTH}×${COVER_HEIGHT}` })
      Logger.info(`Captured the project cover (${COVER_WIDTH}×${COVER_HEIGHT})`, 'Editor')
    } catch (e: any) {
      if (abort.signal.aborted) { task.setStep(0, { status: 'failed', error: 'Cancelled' }); return }
      const message = String(e?.message ?? e)
      task.setStep(0, { status: 'failed', error: message })
      Logger.error(`Could not capture the cover: ${message}`, 'Editor')
    } finally {
      task.finish()
      setCapturing(false)
    }
  }

  return <>
    <Field label='Version' labelClassName={OPTION_LABEL}>
      <TextInput value={version ?? identity.version} placeholder='1.0.0' maxLength={64}
        onChange={setVersion} onBlur={commitVersion}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </Field>
    <Field label='App id' labelClassName={OPTION_LABEL}>
      <TextInput value={appId ?? identity.appId} placeholder={resolveAppId(projectSettings, projectName)} maxLength={128}
        onChange={setAppId} onBlur={commitAppId}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </Field>
    <Field label='Icon' labelClassName={OPTION_LABEL} as='div'>
      <div className='flex flex-1 items-center gap-2'>
        <TextureSlotPicker value={identity.icon || null} fit='contain' onChange={id => setIdentity({ icon: id ?? '' })} />
      </div>
    </Field>
    <Field label='Cover' labelClassName={OPTION_LABEL} as='div'>
      <div className='flex flex-1 items-center gap-2'>
        <TextureSlotPicker value={identity.cover || null} fit='cover' onChange={id => setIdentity({ cover: id ?? '' })} busy={capturing} />
        <Button size='icon' variant='subtle' disabled={capturing || !!blocked}
          title={blocked ?? `Capture the editing view at ${COVER_WIDTH}×${COVER_HEIGHT}, full detail, without the editor's overlays`}
          className={cn('w-[28px] h-[28px]', capturing && 'text-highlight')}
          onClick={() => void capture()}>
          <span className='block w-4 h-4'>{capturing ? <SpinnerIcon /> : <CameraIcon />}</span>
        </Button>
      </div>
    </Field>
  </>
}
