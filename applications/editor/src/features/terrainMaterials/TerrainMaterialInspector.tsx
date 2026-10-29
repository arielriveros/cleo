import { useMemo, useState } from 'react'
import { Node, ModelNode, TerrainMaterial, Material, setTerrainSurfaceFrom } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import { DocScope, Hint, NumberInput, TextInput, Toggle, cn, labelClass } from '../../components/ui'
import MaterialPicker, { liveMaterial } from './MaterialPicker'
import { blankSlotSurface } from '../../utils/landscapeSlots'
import TerrainSlots, { SurfaceLook } from './TerrainSlots'
import TerrainFoliageRules from './TerrainFoliageRules'

/** Terrain side length quoted when no landscape is open (matches the default a landscape is created at). */
const ESTIMATE_SIZE = 200

// Right-sidebar inspector for the active terrain-material tab: the base surface, the terrain blend
// fields and the foliage include/exclude lists, edited on the preview sphere's TerrainMaterial in place.
export default function TerrainMaterialInspector(props: { node: Node | null }) {
  const { eventEmitter, editingTerrainMaterialName, setActiveTerrainMaterialName, refreshTerrainMaterialPreview, editorScene } = useCleoEngine()
  const [, force] = useState(0)
  const rerender = () => force(x => x + 1)

  const node = props.node
  const tm = node && node.nodeType === 'model' ? ((node as ModelNode).model?.material as TerrainMaterial | undefined) : undefined
  const isTerrain = tm instanceof TerrainMaterial

  // ABOVE the `isTerrain` guard below, and it has to be: this is a hook, and the guard returns early.
  // With it underneath, a render where `isTerrain` was false ran six hooks and the next one — after the
  // panel had a terrain material to show — ran seven, which is the "Rendered more hooks than during the
  // previous render" crash. `tm?.tiling` rather than `mat.tiling` for the same reason: `mat` is the
  // non-null alias that only exists past the guard.
  //
  // The active landscape decides what a tiling number means in metres; without one, quote the default
  // the Landscape panel creates so the figure is never silently absent. The tiling is in the deps but
  // not read: it is the re-render this panel already causes on every edit, and reusing it keeps the
  // lookup refreshing as landscapes come and go without a subscription of its own.
  const landscape = useMemo(() => {
    for (const l of editorScene.landscapes) return l.terrain
    return null
  }, [editorScene, tm?.tiling])
  const changed = () => { refreshTerrainMaterialPreview(); eventEmitter.emit('SCENE_CHANGED'); rerender() }

  const label = labelClass
  const num = 'w-16 px-1 py-0.5'

  if (!isTerrain) {
    return <div className={cn('p-3', labelClass)}>Open a landscape material to edit it.</div>
  }
  const mat = tm!

  const landscapeSize = landscape?.size ?? ESTIMATE_SIZE
  // What an elevation rule is judged against on the landscape being authored: metres above ITS origin,
  // which is the one thing a number typed in this panel cannot be guessed from.
  const heights = landscape?.heightRange?.()
  const elevationHint = heights
    ? `This landscape runs ${heights.min.toFixed(1)}–${heights.max.toFixed(1)} m above its origin`
    : 'Metres above the landscape’s origin'
  const repeatMetres = landscapeSize / Math.max(mat.tiling, 0.01)
  // The depth half of this readout is gone with `TERRAIN_RELIEF_ENABLED`: quoting a relief depth for a
  // march that is switched off is exactly the kind of number that sends someone hunting for a bug. The
  // repeat itself still earns its place — it is the only thing that turns a tiling COUNT into a size an
  // author can picture, and tiling still drives every layer texture.

  // Documented under terrain.md › Landscape materials, so its titles (Ground, Slots, the foliage lists)
  // look there before the rest of the page — the Landscape Layers panel has a "Slots" of its own.
  return (
    <DocScope page='editor/terrain' section='landscape-materials'>
      <div className='flex flex-col text-fg bg-surface-raised w-full h-full overflow-y-auto'>
        <div className='p-2 border-b border-success'>
          <label className={cn(labelClass, 'block mb-1')}>Landscape material name</label>
          <TextInput
            className='border-success'
            value={editingTerrainMaterialName ?? ''}
            onChange={(v) => setActiveTerrainMaterialName(v)} />
        </div>

        {/* The GROUND: slot 0, the landscape material's own surface, covering the whole landscape. Taken
            from a Material asset like every other slot — picked, or made right here — instead of an inline
            base-material editor. An asset authored before this keeps its surface ("built-in"); "+ New
            material" turns that surface into an asset, so nothing is lost by linking it. */}
        <Collapsable title='Ground'>
          <div className='p-2 space-y-2'>
            <MaterialPicker value={mat.surfaceMaterialId} placeholder='(built-in surface)'
              newName={() => `${editingTerrainMaterialName || 'Landscape'} ground`}
              // The built-in surface when it HAS a texture (nothing is lost by linking it); otherwise a
              // white blank — the default ground's green tint would multiply into whatever texture comes next.
              seed={() => ['baseColorTexture', 'baseTexture', 'texture'].some(k => mat.textures.get(k))
                ? Material.parse({ ...mat.serialize(), terrainMaterial: undefined })
                : blankSlotSurface()}
              onPick={a => { setTerrainSurfaceFrom(mat, liveMaterial(a)); mat.surfaceMaterialId = a.id; changed() }} />
            <div className='flex items-center justify-between'>
              <span className={label}>Tiling</span>
              {/* Floored: 0 or a negative makes `log2(tiling)` -inf in the shader. */}
              <NumberInput className={num} min={0.01} step={1} value={mat.tiling}
                     onChange={v => { mat.tiling = Math.max(0.01, v); changed() }} />
            </div>
            {/* THE NUMBER NOBODY COULD SEE. Tiling is a repeat COUNT across the whole terrain, so what
                it means in metres depends on a size edited in a different panel: 31 across 400 m is a
                12.9 m repeat, which makes a brick in a brick texture over three metres wide. */}
            <Hint>
              One repeat = <b>{repeatMetres.toFixed(2)} m</b> across a {landscapeSize} m terrain
            </Hint>
            <div className='flex items-center justify-between'>
              <span className={label} title='Let the whole-landscape foliage grow where the ground shows. The ground’s own foliage (below) grows there regardless.'>Allow landscape foliage</span>
              <Toggle checked={mat.allowFoliage} onChange={c => { mat.allowFoliage = c; changed() }} />
            </div>
            <SurfaceLook
              normalStrength={mat.normalStrength} antiTiling={mat.antiTiling}
              onNormalStrength={v => { mat.normalStrength = v; changed() }}
              onAntiTiling={v => { mat.antiTiling = v; changed() }} />
            <TerrainFoliageRules
              material={mat}
              rules={mat.groundFoliageInclude}
              exclude={mat.groundFoliageExclude}
              setExclude={names => { mat.groundFoliageExclude = names }}
              onChange={changed}
              title='Foliage on Ground' excludeTitle='Keep off Ground' defaultOpen={false} />
          </div>
        </Collapsable>

        <TerrainSlots material={mat} onChange={changed} elevationHint={elevationHint} />

        {/* Foliage for the WHOLE landscape: wherever the material is, on every surface that allows it. */}
        <TerrainFoliageRules
          material={mat}
          rules={mat.foliageInclude}
          exclude={mat.foliageExclude}
          setExclude={names => { mat.foliageExclude = names }}
          onChange={changed}
          title='Foliage — whole landscape' excludeTitle='Exclude foliage — whole landscape' />
      </div>
    </DocScope>
  )
}
