import React, { useEffect, useState } from 'react'
import { useEditorSessions } from '../EditorSessionsContext'
import { Modal, ModalHeader, ModalFooter, Toggle } from '../../components/ui'

// Centered review modal shown once per imported model, between parsing and committing to the library.
// Surfaces import state, lets the user upload textures the model references but that were missing from
// the upload, and offers scale normalization. Accept commits (thumbnail + material assets + add); Cancel
// discards. Mounted globally in Editor so it overlays the whole editor.
export default function ModelImportModal() {
  const { pendingModelImport, resolveModelImport } = useEditorSessions()

  const [extraFiles, setExtraFiles] = useState<File[]>([])
  const [resolved, setResolved] = useState<Set<string>>(new Set())
  const [ignoredCount, setIgnoredCount] = useState(0)
  const [normalize, setNormalize] = useState(true)
  const [targetSize, setTargetSize] = useState(2)
  const [separate, setSeparate] = useState(false)

  // Reset per-import state whenever a new review opens.
  useEffect(() => {
    setExtraFiles([])
    setResolved(new Set())
    setIgnoredCount(0)
    setNormalize(true)
    setTargetSize(2)
    setSeparate(false)
  }, [pendingModelImport])

  if (!pendingModelImport) return null
  const info = pendingModelImport

  const currentSize = info.sizeRadius * 2
  const factor = normalize && info.sizeRadius > 0 ? targetSize / (info.sizeRadius * 2) : 1

  const baseName = (p: string) => p.split(/[\\/]/).pop() || p

  // Select all the missing texture files at once; each is matched to a missing entry by filename and linked.
  const onSelectMissing = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    // Lookup of still-unresolved missing names, keyed by lowercased basename.
    const wanted = new Map<string, string>()
    for (const name of info.missing) if (!resolved.has(name)) wanted.set(name.toLowerCase(), name)

    let ignored = 0
    for (const file of Array.from(fileList)) {
      const target = wanted.get(baseName(file.name).toLowerCase())
      if (!target) { ignored++; continue }
      // Eagerly copy bytes before re-wrapping: an <input> File is disk-backed and can lose that backing
      // (blob URL 404s with ERR_FILE_NOT_FOUND) by the time the deferred re-parse reads it.
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
    separate: separate && info.subMeshCount > 1,
  })
  const cancel = () => resolveModelImport(null)

  return (
    <Modal onClose={cancel} className='w-[420px]'>
        <ModalHeader>
          <div className='text-sm font-semibold'>Import model</div>
          <div className='text-lg font-bold truncate' title={info.bundleName}>{info.bundleName}</div>
        </ModalHeader>

        <div className='px-4 py-3 space-y-4 text-sm'>
          {/* Summary */}
          <div className='flex gap-4 text-xs text-gray-300'>
            <span>{info.subMeshCount} part{info.subMeshCount === 1 ? '' : 's'}</span>
            <span>{info.materialCount} material{info.materialCount === 1 ? '' : 's'}</span>
          </div>

          {/* Missing textures */}
          <div>
            <div className='flex items-center justify-between mb-1'>
              <span className='text-xs font-semibold'>Textures</span>
              {info.missing.length > 0 && (
                <label className='text-[11px] bg-control hover:bg-control-hover rounded px-2 py-1 cursor-pointer'>
                  Select missing textures…
                  <input type='file' multiple className='hidden' accept='.png,.jpg,.jpeg,.bmp,.tga,.tiff,.webp'
                         onChange={(e) => { onSelectMissing(e.target.files); e.target.value = '' }} />
                </label>
              )}
            </div>
            {info.missing.length === 0 ? (
              <p className='text-xs text-gray-400'>All referenced textures are present.</p>
            ) : (
              <div className='space-y-1'>
                <p className='text-[11px] text-warning'>
                  {resolved.size} of {info.missing.length} linked — select the missing texture files (matched by filename).
                </p>
                {info.missing.map(name => {
                  const done = resolved.has(name)
                  return (
                    <div key={name} className='flex items-center gap-2 bg-surface-raised border border-control rounded px-2 py-1'>
                      <span className={`text-xs truncate flex-1 ${done ? 'text-green-400 line-through' : ''}`} title={name}>{name}</span>
                      <span className={`text-xs ${done ? 'text-green-400' : 'text-gray-500'}`}>{done ? '✓ linked' : 'missing'}</span>
                    </div>
                  )
                })}
                {ignoredCount > 0 && (
                  <p className='text-[11px] text-gray-500'>{ignoredCount} selected file{ignoredCount === 1 ? '' : 's'} didn’t match a missing name and {ignoredCount === 1 ? 'was' : 'were'} ignored.</p>
                )}
              </div>
            )}
          </div>

          {/* Separation — only worth asking about when the file actually holds more than one piece. */}
          {info.subMeshCount > 1 && (
            <div>
              <div className='text-xs font-semibold mb-1'>Contents</div>
              <Toggle label='Separate sub-models into individual assets' checked={separate} onChange={setSeparate} />
              <p className='text-[11px] text-gray-400 mt-1'>
                {separate
                  ? `Creates ${info.subMeshCount} separate model assets, each centred on its own origin.`
                  : `Creates 1 model asset containing all ${info.subMeshCount} parts.`}
              </p>
              {separate && (
                <p className='text-[11px] text-warning mt-1'>
                  A single model split across several materials will import as separate pieces — leave this
                  off for characters and props that are meant to stay together.
                </p>
              )}
            </div>
          )}

          {/* Scale normalization */}
          <div>
            <div className='text-xs font-semibold mb-1'>Size</div>
            <Toggle label='Normalize size' checked={normalize} onChange={setNormalize} />
            <div className={`flex items-center gap-2 mt-2 text-xs ${normalize ? '' : 'opacity-40 pointer-events-none'}`}>
              <span className='text-gray-300'>Fit to</span>
              <input type='number' min={0.01} step={0.1} value={targetSize}
                     onChange={(e) => setTargetSize(parseFloat(e.target.value) || 0)}
                     className='w-[70px] bg-surface-raised border border-control rounded px-2 py-1 text-white' />
              <span className='text-gray-300'>units</span>
            </div>
            <p className='text-[11px] text-gray-400 mt-1'>
              Current size ≈ {currentSize.toFixed(2)} units{normalize && info.sizeRadius > 0 ? ` → scale ×${factor.toFixed(4)}` : ''}
            </p>
          </div>
        </div>

        <ModalFooter>
          <button className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover' onClick={cancel}>Cancel</button>
          <button className='px-3 py-1.5 text-xs rounded bg-success hover:bg-success-hover font-semibold' onClick={accept}>Accept & Import</button>
        </ModalFooter>
    </Modal>
  )
}
