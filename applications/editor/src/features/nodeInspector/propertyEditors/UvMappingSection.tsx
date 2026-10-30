import { useEffect, useState } from 'react'
import { Material, applyUvMapping, uvConfigOf, type UvConfig } from 'cleo'
import { PropertyTable, PropertyRow, Section, Select, NumberInput, VectorInput, Slider, Hint } from '@cleo/app-kit/ui'

// How a lit material maps its textures: the mesh's uv (tiled/offset), or a box / triplanar projection in
// metres that does not stretch on scaled geometry. See UvConfig in src/graphics/material.ts. Explained in
// docs/editor/models-and-materials.md (the material editor's UV Mapping).

export default function UvMappingSection({ material, onChange }: { material: Material; onChange: () => void }) {
  const [cfg, setCfg] = useState<Required<UvConfig>>(() => uvConfigOf(material))
  useEffect(() => { setCfg(uvConfigOf(material)) }, [material])

  const write = (patch: Partial<UvConfig>) => {
    const next = { ...cfg, ...patch } as Required<UvConfig>
    applyUvMapping(material, next)
    setCfg(uvConfigOf(material))
    onChange()
  }
  const projected = cfg.uvProjection !== 'mesh'

  return (
    <Section title='UV Mapping'>
      <PropertyTable columns={['40%', '60%']}>
        <PropertyRow label='Projection'>
          <Select value={cfg.uvProjection} onChange={(e) => write({ uvProjection: e.target.value as UvConfig['uvProjection'] })}>
            <option value='mesh'>Mesh UV</option>
            <option value='box'>Box (walls, floors, props)</option>
            <option value='triplanar'>Triplanar (rocks, organic)</option>
          </Select>
        </PropertyRow>
        {projected && (
          <>
            <PropertyRow label='Space' hint='Object follows the object and its scale. World makes neighbouring pieces continue the same pattern.'>
              <Select value={cfg.uvSpace} onChange={(e) => write({ uvSpace: e.target.value as UvConfig['uvSpace'] })}>
                <option value='object'>Object</option>
                <option value='world'>World</option>
              </Select>
            </PropertyRow>
            <PropertyRow label='Size (m)' hint='Metres covered by one repeat of the texture.'>
              <NumberInput min={0.01} step={0.25} value={cfg.uvWorldSize}
                onChange={(v) => write({ uvWorldSize: Math.max(0.01, v) })} />
            </PropertyRow>
          </>
        )}
        {cfg.uvProjection === 'triplanar' && (
          <PropertyRow label='Blend' hint='How sharply the three projections meet: low is soft, high is nearly a box.'>
            <Slider min={1} max={16} step={0.5} value={cfg.uvBlend} readout={(v) => v.toFixed(1)}
              onChange={(v) => write({ uvBlend: v })} />
          </PropertyRow>
        )}
        <PropertyRow label='Tiling'>
          <VectorInput value={cfg.uvTiling} labels={['U', 'V']} axisColors={false} step={0.1}
            onChange={(v: number[]) => write({ uvTiling: [v[0], v[1]] })} />
        </PropertyRow>
        <PropertyRow label='Offset' divider={false}>
          <VectorInput value={cfg.uvOffset} labels={['U', 'V']} axisColors={false} step={0.05}
            onChange={(v: number[]) => write({ uvOffset: [v[0], v[1]] })} />
        </PropertyRow>
      </PropertyTable>
      {projected && <Hint className='mt-1'>Ignores the model's UVs; the texture is projected in {cfg.uvSpace} space.</Hint>}
    </Section>
  )
}
