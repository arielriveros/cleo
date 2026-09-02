import { useMemo } from 'react'
import { Field, SegmentedControl, TextInput, Toggle, hintClass, sectionTitleClass } from '../../components/ui'
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

  return (
    <div className='flex flex-col gap-3 p-2'>
      <Field label='Name'>
        <TextInput value={asset.name} onChange={rename} />
      </Field>

      <div>
        <div className={sectionTitleClass}>Source</div>
        <div className={hintClass}>
          {asset.source.kind === 'image'
            ? `${image?.name ?? asset.source.imageId}${image?.byteSize ? ` · ${Math.round(image.byteSize / 1024)} KB` : ''}`
            : asset.source.kind === 'pack'
              ? 'Channel pack'
              : 'Provided by the engine — this texture has no stored image.'}
        </div>
      </div>

      <div>
        <div className={sectionTitleClass}>Wrapping</div>
        <Field label='U'>
          <SegmentedControl value={s.wrapU} onChange={(v) => patch({ wrapU: v })} options={WRAPS} size='sm' grow />
        </Field>
        <Field label='V'>
          <SegmentedControl value={s.wrapV} onChange={(v) => patch({ wrapV: v })} options={WRAPS} size='sm' grow />
        </Field>
      </div>

      <div>
        <div className={sectionTitleClass}>Filtering</div>
        <Field label='Magnify' hint='Sampling when the texture is drawn larger than its texels. Nearest keeps pixel art sharp.'>
          <SegmentedControl value={s.magFilter} onChange={(v) => patch({ magFilter: v })} options={FILTERS} size='sm' grow />
        </Field>
        <Field label='Minify' hint='Sampling when the texture is drawn smaller than its texels.'>
          <SegmentedControl value={s.minFilter} onChange={(v) => patch({ minFilter: v })} options={FILTERS} size='sm' grow />
        </Field>
      </div>

      <div>
        <div className={sectionTitleClass}>Mipmaps</div>
        <Field label='Generate' hint='Prefiltered smaller copies, sampled as a surface recedes. Without them a minified texture shimmers.'>
          <Toggle checked={s.mipMap} onChange={(v) => patch({ mipMap: v })} />
        </Field>
        {s.mipMap && (
          <>
            <Field label='Between levels'>
              <SegmentedControl value={s.mipMapFilter} onChange={(v) => patch({ mipMapFilter: v })} options={FILTERS} size='sm' grow />
            </Field>
            <Field label='Anisotropy' hint='Extra samples along the view direction, for surfaces seen at a grazing angle.'>
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
      </div>

      <div>
        <div className={sectionTitleClass}>Interpretation</div>
        <Field label='Contents' hint='Colour maps are decoded to linear by the shaders; data maps must not be.'>
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
          <div className='rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning'>
            Marked {s.colorSpace === 'srgb' ? 'Colour' : 'Data'} but bound to a{' '}
            {s.colorSpace === 'srgb' ? 'data' : 'colour'} slot on {mismatches.length}{' '}
            material{mismatches.length === 1 ? '' : 's'}: {mismatches.slice(0, 3).join(', ')}
            {mismatches.length > 3 ? '…' : ''}
          </div>
        )}
        <Field label='Flip Y' hint='Images are top-left origin and the GPU samples bottom-left, so this is on for almost everything.'>
          <Toggle checked={s.flipY} onChange={(v) => patch({ flipY: v })} />
        </Field>
        <Field label='Precision' hint='Float allocates a wider format, for maps whose values exceed 0..1.'>
          <SegmentedControl
            value={s.precision}
            onChange={(v) => patch({ precision: v })}
            options={[{ value: 'low', label: '8-bit' }, { value: 'high', label: 'Float' }]}
            size='sm'
            grow
          />
        </Field>
      </div>

      <div className={hintClass}>
        Wrapping, filters and mipmaps take effect in the viewport as you change them. Flip Y and Precision
        change how the bytes are uploaded, so they apply on the next load.
      </div>
    </div>
  )
}
