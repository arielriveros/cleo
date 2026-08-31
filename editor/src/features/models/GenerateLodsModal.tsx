import React, { useState } from 'react'
import { Modal, ModalHeader, ModalFooter, Toggle } from '../../components/ui'
import { halveTo } from '../../utils/lodTextures'
import { clamp } from '../../utils/math';

// Per-level control over generated LOD levels. Hosted by ModelInspector with plain local state rather
// than the globally-mounted pending/resolver pattern — that exists for flows that PARK on the user's
// answer (model import awaits it mid-parse); this one just collects a form and calls an action.

const GENERATE_HINT = 'Each level becomes its own model asset in the library, decimated from this one and referenced as a level. Regenerating updates those assets rather than adding more.'
const DOWNSCALE_ON_HINT = 'Levels landing on the same size share one image, so a second level costs no extra texture memory. Small maps stop at 64px, and maps whose alpha carries data are left at full size.'
const DOWNSCALE_OFF_HINT = 'Levels reuse this model’s materials and textures unchanged — only the triangle count drops.'

export interface GenerateLodsSpec {
    ratio: number
    distance: number
}

/** Sensible opening ladder: halve, quarter, tenth, at distances derived from the model's own size. */
export function defaultSpecs(modelDiameter: number): GenerateLodsSpec[] {
    const step = Math.max(5, Math.round(modelDiameter * 8))
    return [
        { ratio: 0.5, distance: step },
        { ratio: 0.25, distance: step * 2 },
        { ratio: 0.1, distance: step * 4 },
    ]
}

export interface GenerateLodsModalProps {
    modelName: string
    /** LOD0's triangle count, so the summary can be concrete rather than a percentage. */
    sourceTriangles: number
    /** Largest source texture dimension, for the resolution ladder readout. 0 when the model has none. */
    largestTexture: number
    initial: GenerateLodsSpec[]
    onCancel: () => void
    onGenerate: (specs: GenerateLodsSpec[], downscaleTextures: boolean) => void
}

export default function GenerateLodsModal(props: GenerateLodsModalProps) {
    const [specs, setSpecs] = useState<GenerateLodsSpec[]>(props.initial)
    const [downscale, setDownscale] = useState(true)

    const patch = (i: number, next: Partial<GenerateLodsSpec>) =>
        setSpecs(prev => prev.map((s, k) => (k === i ? { ...s, ...next } : s)))

    const addLevel = () => setSpecs(prev => {
        const last = prev[prev.length - 1]
        return [...prev, {
            ratio: Math.max(0.02, (last?.ratio ?? 0.5) / 2),
            distance: Math.round((last?.distance ?? 25) * 2),
        }]
    })

    const num = 'w-[74px] bg-surface-raised border border-control rounded px-2 py-1 text-white text-right'
    const tris = (ratio: number) => Math.max(0, Math.round(props.sourceTriangles * ratio)).toLocaleString()

    // Distances must ascend, or LodGroupNode picks a level the user did not intend.
    const outOfOrder = specs.some((s, i) => i > 0 && s.distance <= specs[i - 1].distance)

    return (
        <Modal onClose={props.onCancel} className='w-[460px]'>
            <ModalHeader>
                <div className='text-sm font-semibold'>Generate LOD levels</div>
                <div className='text-lg font-bold truncate' title={props.modelName}>{props.modelName}</div>
            </ModalHeader>

            <div className='px-4 py-3 space-y-3 text-sm' title={GENERATE_HINT}>
                <div className='space-y-2'>
                    <div className='flex items-center gap-2 text-[11px] text-gray-400 px-1'>
                        <span className='w-[46px]'>Level</span>
                        <span className='flex-1'>Triangles</span>
                        <span className='w-[74px] text-right'>From dist.</span>
                        {downscale && <span className='w-[60px] text-right'>Textures</span>}
                    </div>
                    {specs.map((s, i) => (
                        <div key={i} className='flex items-center gap-2'>
                            <span className='w-[46px] text-xs'>LOD{i + 1}</span>
                            <div className='flex-1 flex items-center gap-2'>
                                <input type='number' min={1} max={99} className={num}
                                       value={Math.round(s.ratio * 100)}
                                       onChange={e => patch(i, { ratio: clamp(Number(e.target.value) / 100, 0.01, 0.99) })} />
                                <span className='text-[11px] text-gray-400'>% · ~{tris(s.ratio)}</span>
                            </div>
                            <input type='number' min={0} className={num}
                                   value={s.distance}
                                   onChange={e => patch(i, { distance: Math.max(0, Number(e.target.value)) })} />
                            {downscale && (
                                <span className='w-[60px] text-right text-[11px] text-gray-400'>
                                    {props.largestTexture > 0 ? `${halveTo(props.largestTexture, i + 1)}px` : '—'}
                                </span>
                            )}
                            {specs.length > 1 && (
                                <button className='text-red-300 text-xs px-1' title='Remove this level'
                                        onClick={() => setSpecs(prev => prev.filter((_, k) => k !== i))}>✕</button>
                            )}
                        </div>
                    ))}
                    <button className='text-[11px] bg-control hover:bg-control-hover rounded px-2 py-1'
                            onClick={addLevel}>+ Add level</button>
                </div>

                <div className='pt-2 border-t border-control'>
                    <Toggle label='Halve texture resolution per level' checked={downscale} onChange={setDownscale}
                            title={downscale ? DOWNSCALE_ON_HINT : DOWNSCALE_OFF_HINT} />
                </div>

                {outOfOrder && (
                    <p className='text-[11px] text-warning'>
                        Distances must increase with each level, or the wrong level takes over.
                    </p>
                )}
                {props.sourceTriangles === 0 && (
                    <p className='text-[11px] text-warning'>This model has no geometry to reduce.</p>
                )}
            </div>

            <ModalFooter>
                <button className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover' onClick={props.onCancel}>Cancel</button>
                <button className='px-3 py-1.5 text-xs rounded bg-success hover:bg-success-hover font-semibold disabled:opacity-40'
                        disabled={outOfOrder || specs.length === 0 || props.sourceTriangles === 0}
                        onClick={() => props.onGenerate(specs, downscale)}>
                    Generate {specs.length} level{specs.length === 1 ? '' : 's'}
                </button>
            </ModalFooter>
        </Modal>
    )
}
