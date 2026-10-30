import React, { useEffect, useState } from 'react'
import { useEditorSessions } from '../EditorSessionsContext'
import { DocScope, Modal, ModalHeader, ModalFooter, SectionTitle, Toggle, Button, FileButton, NumberInput, cn, hintClass } from '@cleo/app-kit/ui'
import SubmeshGroupEditor from './SubmeshGroupEditor'
import { defaultGroupsByMaterial, compactGroups, type PartGroup } from '../../utils/submeshGroups'

// Review modal shown once per imported model, between parsing and committing to the library: import
// state, replacements for referenced-but-missing textures, and scale normalization.
export default function ModelImportModal() {
  const { pendingModelImport, resolveModelImport } = useEditorSessions()

  const [extraFiles, setExtraFiles] = useState<File[]>([])
  const [resolved, setResolved] = useState<Set<string>>(new Set())
  const [ignoredCount, setIgnoredCount] = useState(0)
  const [normalize, setNormalize] = useState(true)
  const [targetSize, setTargetSize] = useState(2)
  const [separate, setSeparate] = useState(false)
  const [merge, setMerge] = useState(false)
  // Only meaningful with both toggles on; seeded on the transition into that state, not on every render.
  const [groups, setGroups] = useState<PartGroup[]>([])

  useEffect(() => {
    setExtraFiles([])
    setResolved(new Set())
    setIgnoredCount(0)
    setNormalize(true)
    setTargetSize(2)
    setSeparate(false)
    setMerge(false)
    setGroups([])
  }, [pendingModelImport])

  if (!pendingModelImport) return null
  const info = pendingModelImport

  // Both toggles on = "split into assets, and merge within each" — which only has an answer once the
  // user says what goes with what, so the grouping editor appears and its result is the import.
  const grouping = separate && merge && info.subMeshCount > 1
  const assetCount = compactGroups(groups).length

  // Seed on the transition into grouping, keeping any partition the user already built this session.
  const seedGroups = () => setGroups(g => (g.length ? g : defaultGroupsByMaterial(info.parts, info.bundleName)))

  const currentSize = info.sizeRadius * 2
  const factor = normalize && info.sizeRadius > 0 ? targetSize / (info.sizeRadius * 2) : 1

  const baseName = (p: string) => p.split(/[\\/]/).pop() || p

  const onSelectMissing = async (fileList: File[]) => {
    if (fileList.length === 0) return
    // Still-unresolved missing names, keyed by lowercased basename — that is the match key.
    const wanted = new Map<string, string>()
    for (const { name } of info.missing) if (!resolved.has(name)) wanted.set(name.toLowerCase(), name)

    let ignored = 0
    for (const file of fileList) {
      const target = wanted.get(baseName(file.name).toLowerCase())
      if (!target) { ignored++; continue }
      // Copy the bytes before re-wrapping: an <input> File is disk-backed and can lose that backing
      // (blob URL 404s) by the time the deferred re-parse reads it.
      const buf = await file.arrayBuffer()
      const aliased = new File([buf], target, { type: file.type || 'image/png' }) // alias to expected name
      setExtraFiles(prev => [...prev, aliased])
      setResolved(prev => new Set(prev).add(target))
      wanted.delete(baseName(file.name).toLowerCase()) // one file per missing entry
    }
    if (ignored) setIgnoredCount(c => c + ignored)
  }

  const accept = () => resolveModelImport({
    extraFiles,
    normalize,
    targetSize: targetSize > 0 ? targetSize : 2,
    // separate/merge stay mutually exclusive on the wire: they are what the import falls back to if the
    // grouping can no longer be applied (a re-parse for missing textures rebuilds the sub-mesh list).
    separate: separate && info.subMeshCount > 1,
    merge: merge && !separate && info.subMeshCount > 1,
    groups: grouping ? compactGroups(groups) : undefined,
  })
  const cancel = () => resolveModelImport(null)

  // Mounted at the editor root, outside every panel's docs scope: it declares its own.
  return (
    <DocScope page='editor/models-and-materials' section='the-review-modal'>
      <Modal onClose={cancel} className={grouping ? 'w-[600px]' : 'w-[420px]'}>
          <ModalHeader title='Import model' doc='editor/models-and-materials#the-review-modal'
            aside={<span title={info.bundleName}>{info.bundleName}</span>} />

          <div className='px-4 py-3 space-y-4 text-ui'>
            {/* Summary */}
            <div className='flex gap-4 text-ui text-muted'>
              <span>{info.subMeshCount} part{info.subMeshCount === 1 ? '' : 's'}</span>
              <span>{info.materialCount} material{info.materialCount === 1 ? '' : 's'}</span>
            </div>

            {/* Missing textures */}
            <div>
              <div className='flex items-center justify-between mb-1'>
                <SectionTitle title='Textures' doc='Missing textures' />
                {info.missing.length > 0 && (
                  <FileButton multiple accept='.png,.jpg,.jpeg,.bmp,.tga,.tiff,.webp' onFiles={(files) => { void onSelectMissing(files) }}>
                    Select missing textures…
                  </FileButton>
                )}
              </div>
              {info.missing.length === 0 && info.unloadable.length === 0 ? (
                <p className='text-ui text-muted'>All referenced textures are present.</p>
              ) : info.missing.length === 0 ? null : (
                <div className='space-y-1'>
                  {/* Say what the list IS. A bare filename reads as the importer demanding something for
                      no reason; the model is the one asking, and the file simply wasn't in the upload. */}
                  <p className='text-ui-sm text-warning'>
                    The model references {info.missing.length} image{info.missing.length === 1 ? '' : 's'} that
                    {info.missing.length === 1 ? " wasn't" : " weren't"} in your upload
                    {' '}({resolved.size} linked). Select them, or import the model together with its texture files.
                  </p>
                  {info.missing.map(({ name, from }) => {
                    const done = resolved.has(name)
                    return (
                      <div key={name} className='flex items-center gap-2 bg-surface-raised border border-control rounded px-2 py-1'>
                        <div className='min-w-0 flex-1'>
                          <div className={cn('text-ui truncate', done && 'text-success-fg line-through')} title={name}>{name}</div>
                          <div className='text-ui-xs text-dim truncate' title={from}>{from}</div>
                        </div>
                        <span className={cn('text-ui shrink-0', done ? 'text-success-fg' : 'text-dim')}>{done ? '✓ linked' : 'missing'}</span>
                      </div>
                    )
                  })}
                  {ignoredCount > 0 && (
                    <p className={hintClass}>{ignoredCount} selected file{ignoredCount === 1 ? '' : 's'} didn’t match a missing name and {ignoredCount === 1 ? 'was' : 'were'} ignored.</p>
                  )}
                </div>
              )}

              {/* Embedded references that failed to decode. No file picker: there is no file to pick — the
                  image lives inside the model and is in a format the browser can't read. Saying so beats
                  importing a silently untextured model, which is what used to happen. */}
              {info.unloadable.length > 0 && (
                <div className='space-y-1 mt-2'>
                  <p className='text-ui-sm text-warning'>
                    {info.unloadable.length} texture{info.unloadable.length === 1 ? '' : 's'} embedded in the
                    model could not be read. Re-export it with the textures as separate .png/.jpg files, then
                    import the model and images together.
                  </p>
                  {info.unloadable.map(({ name, from }) => (
                    <div key={name} className='flex items-center gap-2 bg-surface-raised border border-control rounded px-2 py-1'>
                      <div className='min-w-0 flex-1'>
                        <div className='text-ui truncate' title={name}>{name}</div>
                        <div className='text-ui-xs text-dim truncate' title={from}>{from}</div>
                      </div>
                      <span className='text-ui text-dim shrink-0'>unreadable</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Separation — only worth asking about when the file actually holds more than one piece. */}
            {info.subMeshCount > 1 && (
              <div>
                <SectionTitle title='Contents' className='mb-1' />
                <Toggle label='Separate sub-models into individual assets'
                        checked={separate}
                        onChange={(v: boolean) => { setSeparate(v); if (v && merge) seedGroups() }} />
                <p className='text-ui-sm text-muted mt-1'>
                  {grouping
                    ? `Creates ${assetCount} model asset${assetCount === 1 ? '' : 's'}, each a single merged mesh — one per group below.`
                    : separate
                      ? `Creates ${info.subMeshCount} separate model assets, each centred on its own origin.`
                      : merge
                        ? `Creates 1 model asset with a single merged mesh.`
                        : `Creates 1 model asset containing all ${info.subMeshCount} parts.`}
                </p>

                {/* The opposite of the toggle above. Worth offering because the split is an artefact of the
                    FILE FORMAT (glTF mandates one primitive per material, and tools split a body across
                    several mesh objects), not something the author chose: a merged character is one node
                    with one Animator instead of several that an animation can only drive one of. */}
                <div className='mt-2'>
                  <Toggle label='Merge sub-meshes into a single mesh'
                          checked={merge}
                          onChange={(v: boolean) => { setMerge(v); if (v && separate) seedGroups() }} />
                  <p className='text-ui-sm text-muted mt-1'>
                    {grouping
                      ? 'Merges within each group, so a group of several parts imports as one mesh.'
                      : merge
                        ? `Combines all ${info.subMeshCount} parts into one mesh, keeping one material slot per part.`
                        : 'Keeps the file’s parts as separate nodes under one asset.'}
                  </p>
                  {merge && (
                    <p className={cn(hintClass, 'mt-1')}>
                      Parts that use different material types, or mix opaque and transparent, stay separate —
                      the reason is logged.
                    </p>
                  )}
                </div>

                {/* Both on: neither answer is complete on its own, so ask what goes with what. Seeded one
                    group per material, which is both the usual intent and always mergeable. */}
                {grouping && (
                  <div className='mt-3 pt-3 border-t border-control'>
                    <SubmeshGroupEditor parts={info.parts} bundleName={info.bundleName}
                                        groups={groups} onChange={setGroups} />
                  </div>
                )}

                {separate && !merge && (
                  <p className='text-ui-sm text-warning mt-1'>
                    A single model split across several materials will import as separate pieces — leave this
                    off for characters and props that are meant to stay together.
                  </p>
                )}
              </div>
            )}

            {/* Scale normalization */}
            <div>
              <SectionTitle title='Size' className='mb-1' />
              <Toggle label='Normalize size' checked={normalize} onChange={setNormalize} />
              <div className={cn('flex items-center gap-2 mt-2 text-ui', !normalize && 'opacity-40 pointer-events-none')}>
                <span className='text-muted'>Fit to</span>
                <NumberInput min={0.01} step={0.1} value={targetSize}
                             onChange={setTargetSize}
                             className='w-[70px]' />
                <span className='text-muted'>units</span>
              </div>
              <p className='text-ui-sm text-muted mt-1'>
                Current size ≈ {currentSize.toFixed(2)} units{normalize && info.sizeRadius > 0 ? ` → scale ×${factor.toFixed(4)}` : ''}
              </p>
            </div>
          </div>

          <ModalFooter>
            <Button onClick={cancel}>Cancel</Button>
            <Button variant='success' className='font-semibold' onClick={accept}>Accept & Import</Button>
          </ModalFooter>
      </Modal>
    </DocScope>
  )
}
