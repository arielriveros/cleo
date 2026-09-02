import React, { useRef } from 'react'
import { SoundNode, AudioManager } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useEditorSessions } from '../../EditorSessionsContext'
import { Button, Hint, Select, cn, valueClass } from '../../../components/ui'
import { formatDuration } from '../../../utils/audioSources'
import { useAssetDrop } from '../../../utils/useAssetDrop'

// The sample reference on a Sound node, and the only way an emitter gets audio.
//
// A REFERENCE, not a copy — unlike `TilesetSlot`, which stores a runtime copy on the node. Effects,
// volume, loop points and the bus belong to the sample and are shared by every node playing it, which is
// the whole reason the split exists: retuning one footstep retunes all of them.

export default function SoundSampleSlot(props: { node: SoundNode; onChange?: () => void }) {
  const { eventEmitter } = useCleoEngine()
  const { soundSamples } = useAssetLibrary()
  const { enterSoundEditor } = useEditorSessions()
  const fileInput = useRef<HTMLInputElement>(null)

  const asset = props.node.sampleId
    ? soundSamples.find(s => s.id === props.node.sampleId)
    : undefined

  const commit = () => {
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
    props.onChange?.()
  }

  const assign = (id: string | null) => {
    props.node.sampleId = id
    commit()
  }

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // so re-picking the same file fires again
    if (!file) return
    // Registering the bytes is all this does. The AudioSource and SoundSample records are minted by
    // `reconcileSoundAssets`, which every other import path relies on too.
    //
    // The emit waits for the callback: the file is read asynchronously, so the sample is not registered
    // when this returns, and announcing it early would run the reconciler against a registry that does
    // not hold it yet.
    const id = AudioManager.Instance.addSoundFromFile(file, undefined, file.name, () => {
      eventEmitter.emit('SOUNDS_CHANGED')
    })
    if (id) assign(id)
  }

  const { dragOver, dropProps } = useAssetDrop('text/cleo-sound-sample', id => assign(id))

  // The sample id is set but the library has no record: the asset was deleted, or has not loaded yet.
  const broken = !!props.node.sampleId && !asset

  return (
    <div className='w-full' {...dropProps}>
      <input
        ref={fileInput} type='file' className='hidden'
        accept='.wav,.mp3,.ogg,.m4a,.flac,.aac,.opus,.webm,audio/*'
        onChange={onPickFile}
      />

      <div className={`flex items-center gap-2 p-2 bg-control border rounded ${dragOver ? 'border-selected' : 'border-border'}`}>
        <div className='w-[36px] h-[36px] rounded bg-surface-raised flex items-center justify-center shrink-0 text-lg'>
          {asset ? '🔊' : broken ? '⚠️' : '—'}
        </div>
        <div className='flex-1 min-w-0'>
          {asset ? (
            <>
              <div className={cn(valueClass, 'truncate')} title={asset.name}>{asset.name}</div>
              <Hint>
                {formatDuration(AudioManager.Instance.getSound(asset.id)?.duration ?? 0)}
                {' · '}{asset.settings.bus}
                {asset.settings.effects.length ? ` · ${asset.settings.effects.length} fx` : ''}
              </Hint>
            </>
          ) : broken ? (
            <>
              <div className={cn(valueClass, 'truncate')}>Missing sample</div>
              <Hint>{props.node.sampleId}</Hint>
            </>
          ) : (
            <Hint>No sample — this emitter is silent.</Hint>
          )}
        </div>
        {asset && (
          <Button
            variant='ghost' size='icon' className='text-highlight'
            title='Edit this sound sample' onClick={() => enterSoundEditor(asset.id)}
          >✎</Button>
        )}
        {props.node.sampleId && (
          <Button
            variant='ghost' size='icon' className='text-danger'
            title='Unlink (the emitter falls silent)' onClick={() => assign(null)}
          >✕</Button>
        )}
      </div>

      <div className='flex items-center gap-1 mt-1'>
        <Select
          className='flex-1'
          value={props.node.sampleId ?? ''}
          title='Pick a sound sample from the project'
          onChange={e => assign(e.target.value || null)}
        >
          <option value=''>None</option>
          {soundSamples.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Button size='sm' variant='subtle' title='Import an audio file' onClick={() => fileInput.current?.click()}>
          Import…
        </Button>
      </div>
    </div>
  )
}
