import { useState } from 'react'
import { TextureManager } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import { Button, Field, NumberInput, Select, TextInput, cn, labelClass, hintClass } from '../../components/ui'
import ModelPartsSection from './ModelPartsSection'
import GenerateLodsModal, { defaultSpecs, type GenerateLodsSpec } from './GenerateLodsModal'
import { modelAssetTextureIds, modelAssetDiameter } from '../../utils/models'
// The renderer's own `_foliageCullDistance` default. Mirrored rather than imported because the
// renderer instance is not in scope here, and this panel only needs it to warn about a dead band.
const GLOBAL_FOLIAGE_CULL = 65

const FIELDS_HINT = 'A field blends this model’s clips by 1D or 2D parameters. Use one as a state in the animation graph instead of a single clip.'
const LOD_HINT = 'Each level references another model from the library and takes over at its distance — editing that model updates every level using it. Only LOD0 is edited here; selecting a level just previews it.'

/** Triangles in a serialized model subtree, for the generate dialog's before/after figures. */
function countTriangles(nodeJson: any): number {
  if (!nodeJson || typeof nodeJson !== 'object') return 0
  let n = Math.floor((nodeJson.model?.geometry?.indices?.length ?? 0) / 3)
  for (const child of nodeJson.children ?? []) n += countTriangles(child)
  return n
}

// Right-sidebar inspector for the active model tab: asset name, LOD levels (each another model asset
// plus the camera distance where it takes over) and the distance-cull threshold.
export default function ModelInspector() {
  const {
    activeTab, modelSession, setActiveModelName, models,
    addModelLodFromAsset, generateModelLods, removeModelLod, setModelLodDistance, setModelCullDistance,
    setActiveModelLevel, animationFields, createAnimationFieldForModel, enterAnimationFieldEditor,
  } = useCleoEngine()

  const [generating, setGenerating] = useState(false)

  if (!modelSession) return null

  // Fields belong to the RIG this model is built on, so they are shared with every other character
  // using the same skeleton.
  const modelRigId = models.find(m => m.id === activeTab.modelId)?.rigId
  const fields = modelRigId ? animationFields.filter(f => f.rigId === modelRigId) : []

  // A model may not be its own LOD level, nor appear twice.
  const candidates = models.filter(m =>
    m.id !== activeTab.modelId && !modelSession.lodRefs.some(l => l.modelId === m.id))
  const nameOf = (modelId?: string) => modelId ? (models.find(m => m.id === modelId)?.name ?? 'missing model') : 'embedded (legacy)'

  // Read off the SAVED asset rather than the live tab scene: the modal only needs figures to quote, and
  // the asset is what generation will actually reduce.
  const asset = models.find(m => m.id === activeTab.modelId)
  const sourceTriangles = countTriangles(asset?.nodeJson)
  // The ladder is derived from the model's own size, and this is the number that makes it so. It used
  // to be a hardcoded 2, which gave EVERY model bands at 16/32/64 m — a 25 m oak dropped to half
  // detail closer than its own height, while a 0.4 m fern kept full geometry out to the cull distance.
  // 0 means the asset has no geometry to measure; `defaultSpecs` floors the step, so it is safe to pass.
  const sourceDiameter = modelAssetDiameter(asset?.nodeJson)
  const largestTexture = (asset ? modelAssetTextureIds(asset) : []).reduce((max, id) => {
    const image = TextureManager.Instance.getTexture(id)?.data as HTMLImageElement | undefined
    return Math.max(max, image?.naturalWidth ?? 0, image?.naturalHeight ?? 0)
  }, 0)

  // A level whose band starts at or past the cull distance is never drawn. It is silent otherwise:
  // the level exists, its textures were generated, the panel lists it, and nothing renders it. The
  // effective cull is the asset's own when set, and the renderer's foliage global when it is not.
  const effectiveCull = modelSession.cullDistance > 0 ? modelSession.cullDistance : GLOBAL_FOLIAGE_CULL
  const deadFrom = modelSession.distances.findIndex((d, i) => i > 0 && d >= effectiveCull)

  const label = labelClass
  const num = 'w-16'

  return (
    <div className='flex flex-col text-fg bg-surface-raised w-full'>
      {generating && (
        <GenerateLodsModal
          modelName={activeTab.title}
          sourceTriangles={sourceTriangles}
          largestTexture={largestTexture}
          initial={defaultSpecs(sourceDiameter)}
          onCancel={() => setGenerating(false)}
          onGenerate={(specs: GenerateLodsSpec[], downscale: boolean) => {
            setGenerating(false)
            void generateModelLods(specs, downscale)
          }} />
      )}
      <div className='p-2 border-b border-border'>
        <label className={cn(labelClass, 'block mb-1')}>Model name</label>
        <TextInput
          value={activeTab.title}
          onChange={setActiveModelName} />
      </div>

      <ModelPartsSection />

      {/* Blend spaces belong to a skinned model, which is exactly what this tab has open — so this is the
          natural place to create one. Static models have no clips to blend. */}
      {modelSession.skinned && activeTab.modelId && (
        <Collapsable title='Animation fields' badge={fields.length || undefined} defaultOpen>
          <div className='p-2 space-y-1' title={FIELDS_HINT}>
            {fields.map(f => (
              <Button key={f.id} variant='subtle'
                className='w-full justify-start text-left'
                onClick={() => enterAnimationFieldEditor(f.id)}
                title={`Open the "${f.name}" blend space`}>
                ⊞ {f.name}
              </Button>
            ))}
            <Button variant='subtle'
              className='w-full'
              onClick={() => createAnimationFieldForModel(activeTab.modelId!)}
              title='Create a new blend space from this model'>
              + New Animation Field
            </Button>
          </div>
        </Collapsable>
      )}

      <Collapsable title='LOD levels'>
        <div className='p-2 space-y-2' title={modelSession.skinned ? undefined : LOD_HINT}>
          {modelSession.skinned ? (
            <p className={hintClass}>LOD levels are not available for skinned models.</p>
          ) : (
            <>
              {modelSession.levelIds.map((_, i) => (
                <div key={i} className='border border-control rounded p-2 space-y-1'>
                  <div className='flex items-center gap-2'>
                    <label className='flex items-center gap-1 cursor-pointer flex-1'>
                      <input
                        type='radio'
                        className='accent-primary'
                        name='activeModelLevel'
                        checked={modelSession.activeLevel === i}
                        onChange={() => setActiveModelLevel(i)} />
                      <span className={label}>{i === 0 ? 'LOD0 (base)' : `LOD${i}`}</span>
                    </label>
                    {i > 0 && (
                      <Button variant='remove' size='icon' onClick={() => removeModelLod(i)} title='Remove this level'>✕</Button>
                    )}
                  </div>
                  {i > 0 && (
                    <>
                      <div className='flex items-center justify-between'>
                        <span className={label}>Model</span>
                        <span className='text-ui-sm text-muted truncate max-w-[55%]' title={nameOf(modelSession.lodRefs[i - 1]?.modelId)}>
                          {nameOf(modelSession.lodRefs[i - 1]?.modelId)}
                        </span>
                      </div>
                      <Field label='From distance' className='my-0' labelClassName='w-auto'>
                        <NumberInput
                          min={0} className={num}
                          value={modelSession.distances[i] ?? 0}
                          onChange={v => setModelLodDistance(i, v)} />
                      </Field>
                      {deadFrom >= 0 && i >= deadFrom && (
                        <p className='text-ui-sm text-warning'>
                          Never drawn: everything is culled at {Math.round(effectiveCull)} m
                          {modelSession.cullDistance > 0 ? '' : ' (the renderer\'s default)'}.
                          Raise the cull distance below, or bring this band closer.
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))}
              <Button variant='primary'
                className='w-full font-semibold disabled:opacity-40'
                disabled={sourceTriangles === 0}
                title={sourceTriangles === 0
                  ? 'This model has no geometry to reduce'
                  : 'Decimate this model into reduced levels, with half-resolution textures'}
                onClick={() => setGenerating(true)}>
                Generate LOD levels…
              </Button>

              {candidates.length > 0 ? (
                <Select
                  className='w-full'
                  value=''
                  onChange={e => { if (e.target.value) addModelLodFromAsset(e.target.value); e.target.value = '' }}>
                  <option value=''>Add LOD level from model…</option>
                  {candidates.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              ) : (
                <p className={hintClass}>
                  No other models available — import a lower-poly model into the library to use it as a level.
                </p>
              )}
            </>
          )}

          {!modelSession.skinned && (
            <Field label='Cull distance (0 = never)' hint='Placed copies disappear beyond this camera distance. 0 = never cull.'
                   className='my-0 pt-1 border-t border-control' labelClassName='w-auto'>
              <NumberInput
                min={0} className={num}
                value={modelSession.cullDistance}
                onChange={setModelCullDistance} />
            </Field>
          )}
        </div>
      </Collapsable>
    </div>
  )
}
