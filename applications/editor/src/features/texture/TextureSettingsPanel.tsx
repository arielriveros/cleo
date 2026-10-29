import { useMemo } from 'react'
import { DocScope, Field, Section, SegmentedControl, TextInput, Toggle, hintClass } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../EngineContext'
import { useTexture } from './TextureContext'
import type { FilterMode, WrapMode } from '../../utils/textureAssets'

// The texture inspector, hosted in the Properties panel. Named for what it edits rather than
// `TextureInspector`, which is taken by the material-slot picker in nodeInspector/propertyEditors.

const WRAPS: { value: WrapMode; label: string; title: string }[] = [
  { value: 'repeat', label: 'Repeat', title: 'Tile the image past the edge' },
  { value: 'clamp', label: 'Clamp', title: 'Stretch the edge texel past the edge' },
  { value: 'mirror', label: 'Mirror', title: 'Tile, flipping every other repeat' },
]
const FILTERS: { value: FilterMode; label: string; title: string }[] = [
  { value: 'linear', label: 'Linear', title: 'Blend between texels' },
  { value: 'nearest', label: 'Nearest', title: 'Snap to the nearest texel, which is what keeps pixel art sharp' },
]
// Powers of two: anisotropy is a tap count, and drivers round to one anyway.
const ANISO = [1, 2, 4, 8, 16].map(n => ({ value: n, label: n === 1 ? 'Off' : `${n}x` }))

/** Data slots: a texture bound here is read as numbers, so decoding it as colour is a bug. */
const DATA_SLOTS = ['normalMap', 'metallicMap', 'roughnessMap', 'occlusionMap', 'displacementMap', 'maskMap']

export default function TextureSettingsPanel() {
  const { asset, image, patch, rename } = useTexture()
  const { materials } = useCleoEngine()

  /**
   * Materials binding this texture to a slot whose colour space disagrees with the authored one.
   *
   * The real-world bug is a normal map authored as sRGB: the shaders decode colour with `pow(rgb, 2.2)`,
   * so a normal map claiming to be colour leaves the geometry pass with its vectors bent. Nothing is
   * fixed automatically — which of the two is wrong depends on the map — so this reports and lets the
   * author decide. It is also the only thing `colorSpace` does today; see the plan on why hardware sRGB
   * stays out.
   */
  const mismatches = useMemo(() => {
    if (!asset) return []
    const out: string[] = []
    for (const m of materials as unknown as { name: string; textures?: Record<string, string> }[]) {
      for (const [slot, id] of Object.entries(m.textures ?? {})) {
        if (id !== asset.id) continue
        const wantsLinear = DATA_SLOTS.includes(slot)
        if (wantsLinear === (asset.settings.colorSpace === 'linear')) continue
        out.push(`${m.name} · ${slot}`)
      }
    }
    return out
  }, [asset, materials])

  if (!asset) return null
  const s = asset.settings
  const anisoIgnored = s.anisotropy > 1
    && (s.minFilter !== 'linear' || s.magFilter !== 'linear' || s.mipMapFilter !== 'linear')

  // Each Section is a heading under assets.md › Textures, so its field labels find their rows there.
  return (
    <DocScope page='editor/assets' section='textures'>
      <div className='flex flex-col gap-3 p-2'>
        <Field label='Name'>
          <TextInput value={asset.name} onChange={rename} />
        </Field>

        <Section title='Source' className='mb-0'>
          <div className={hintClass}>
            {asset.source.kind === 'image'
              ? `${image?.name ?? asset.source.imageId}${image?.byteSize ? ` · ${Math.round(image.byteSize / 1024)} KB` : ''}`
              : asset.source.kind === 'pack'
                ? 'Channel pack'
                : 'Provided by the engine — this texture has no stored image.'}
          </div>
        </Section>

        <Section title='Wrapping' className='mb-0'>
          <Field label='U'>
            <SegmentedControl value={s.wrapU} onChange={(v) => patch({ wrapU: v })} options={WRAPS} size='sm' grow />
          </Field>
          <Field label='V'>
            <SegmentedControl value={s.wrapV} onChange={(v) => patch({ wrapV: v })} options={WRAPS} size='sm' grow />
          </Field>
        </Section>

        <Section title='Filtering' className='mb-0'>
          <Field label='Magnify'>
            <SegmentedControl value={s.magFilter} onChange={(v) => patch({ magFilter: v })} options={FILTERS} size='sm' grow />
          </Field>
          <Field label='Minify'>
            <SegmentedControl value={s.minFilter} onChange={(v) => patch({ minFilter: v })} options={FILTERS} size='sm' grow />
          </Field>
        </Section>

        <Section title='Mipmaps' className='mb-0'>
          <Field label='Generate'>
            <Toggle checked={s.mipMap} onChange={(v) => patch({ mipMap: v })} />
          </Field>
          {s.mipMap && (
            <>
              <Field label='Between levels'>
                <SegmentedControl value={s.mipMapFilter} onChange={(v) => patch({ mipMapFilter: v })} options={FILTERS} size='sm' grow />
              </Field>
              <Field label='Anisotropy'>
                <SegmentedControl value={s.anisotropy} onChange={(v) => patch({ anisotropy: v })} options={ANISO} size='sm' grow />
              </Field>
              {anisoIgnored && (
                <div className={hintClass}>
                  Ignored while any filter is Nearest — WebGPU refuses such a sampler outright, so it is
                  forced back to Off on both backends.
                </div>
              )}
            </>
          )}
        </Section>

        <Section title='Interpretation' className='mb-0'>
          <Field label='Contents'>
            <SegmentedControl
              value={s.colorSpace}
              onChange={(v) => patch({ colorSpace: v })}
              options={[
                { value: 'srgb', label: 'Colour', title: 'Albedo, emissive — decoded to linear when lit' },
                { value: 'linear', label: 'Data', title: 'Normals, roughness, masks — read as numbers' },
              ]}
              size='sm'
              grow
            />
          </Field>
          {mismatches.length > 0 && (
            <div className='rounded border border-warning/40 bg-warning/10 px-2 py-1 text-ui-sm text-warning'>
              Marked {s.colorSpace === 'srgb' ? 'Colour' : 'Data'} but bound to a{' '}
              {s.colorSpace === 'srgb' ? 'data' : 'colour'} slot on {mismatches.length}{' '}
              material{mismatches.length === 1 ? '' : 's'}: {mismatches.slice(0, 3).join(', ')}
              {mismatches.length > 3 ? '…' : ''}
            </div>
          )}
          <Field label='Flip Y'>
            <Toggle checked={s.flipY} onChange={(v) => patch({ flipY: v })} />
          </Field>
          <Field label='Precision'>
            <SegmentedControl
              value={s.precision}
              onChange={(v) => patch({ precision: v })}
              options={[{ value: 'low', label: '8-bit' }, { value: 'high', label: 'Float' }]}
              size='sm'
              grow
            />
          </Field>
        </Section>
      </div>
    </DocScope>
  )
}
