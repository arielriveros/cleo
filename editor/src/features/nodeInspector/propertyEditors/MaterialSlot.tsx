import React, { useState } from 'react'
import { Node } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'
import { getMaterialIdsOf, applyMaterialAsset, unlinkMaterialAt, canLinkMaterial, isProjectableMaterial, seedDecalMaterial } from '../../../utils/materials'
import { Select, Button, Hint, cn, valueClass } from '../../../components/ui'
import { MaterialIcon } from '../sectionIcons'
import { useAssetDrop } from '../../../utils/useAssetDrop'
import { toast } from '../../toasts/toastStore'

// The material reference control for model and decal nodes: the linked material (thumbnail + edit/unlink),
// or a create/link affordance when none is set. A model merged at import carries one material per SUBMESH —
// an index range of the shared mesh — so this renders one slot per submesh rather than one per node. A decal
// has exactly one slot, and it only takes PBR materials: every link path below goes through
// `canLinkMaterial`, so a Basic/Default/Cel/custom material is refused out loud rather than accepted and
// then projected as plain white.
export default function MaterialSlot(props: { node: Node }) {
  const [, force] = useState(0) // node mutations don't trigger React; bump to re-read the links

  const model = (props.node as any).model
  const count: number = Math.max(1, model?.materials?.length ?? 1)
  const linkedIds = getMaterialIdsOf(props.node)

  return (
    <Collapsable title={count > 1 ? `Materials (${count})` : 'Material'} icon={<MaterialIcon />} persistKey='materialSlot'>
      {Array.from({ length: count }, (_, i) => (
        <Slot
          key={i}
          node={props.node}
          submesh={i}
          showIndex={count > 1}
          linkedId={linkedIds[i]}
          onChanged={() => force(x => x + 1)}
        />
      ))}
    </Collapsable>
  )
}

function Slot(props: {
  node: Node
  submesh: number
  showIndex: boolean
  linkedId: string | undefined
  onChanged: () => void
}) {
  const { materials, enterMaterialEditor, createMaterialForNode, eventEmitter } = useCleoEngine()

  const asset = props.linkedId ? materials.find(m => m.id === props.linkedId) : undefined

  const changed = () => {
    eventEmitter.emit('TEXTURES_CHANGED')
    eventEmitter.emit('SCENE_CHANGED')
    props.onChanged()
  }
  const isDecal = props.node.nodeType === 'decal'
  const link = (id: string) => {
    const a = materials.find(m => m.id === id)
    if (!a) return
    // The select, the drop target and anything else that links an asset all funnel through here.
    if (!canLinkMaterial(props.node, a)) {
      toast.warning(`“${a.name}” is not a PBR material. A decal can only project PBR materials.`, { title: 'Material not linked' })
      return
    }
    applyMaterialAsset(props.node, a, props.submesh)
    changed()
  }
  // Clears THIS submesh only, never the whole node.
  const unlink = () => { unlinkMaterialAt(props.node, props.submesh); changed() }
  const create = () => {
    // A decal parsed from a payload whose material was not PBR holds none, and there is nothing to build an
    // asset from; give it the placeholder first. A no-op for everything else.
    seedDecalMaterial(props.node)
    createMaterialForNode(props.node, props.submesh)
    props.onChanged()
  }
  const { dragOver, dropProps } = useAssetDrop('text/cleo-material', link)

  return (
    <div className='w-full p-2' {...dropProps}>
      {props.showIndex && <Hint className='mb-1'>Sub-mesh {props.submesh + 1}</Hint>}
      {/* Linked while PBR, then re-saved as another shading model: applyMaterialAsset refused the update,
          so the decal still projects the last PBR version. Say so rather than let the two silently differ. */}
      {asset && isDecal && !isProjectableMaterial(asset.material) &&
        <Hint className='mb-1 text-warning'>“{asset.name}” is no longer a PBR material; this decal keeps projecting its last PBR version.</Hint>}
      {asset ? (
        <div className={`flex items-center gap-2 p-2 bg-control border rounded ${dragOver ? 'border-selected' : 'border-border'}`}>
          <div className='w-[48px] h-[48px] rounded overflow-hidden bg-surface-raised flex items-center justify-center shrink-0'>
            {asset.thumbnail
              ? <img src={asset.thumbnail} className='w-full h-full object-cover' alt={asset.name} draggable={false} />
              : <span className='text-lg'>🎨</span>}
          </div>
          <span className={cn(valueClass, 'truncate flex-1')} title={asset.name}>{asset.name}</span>
          <Button variant='ghost' size='icon' className='text-highlight' title='Edit this material' onClick={() => enterMaterialEditor(asset.id)}>✎</Button>
          <Button variant='ghost' size='icon' className='text-danger'
            title={isDecal ? 'Unlink (revert to the placeholder decal material)' : 'Unlink (revert to a basic material)'} onClick={unlink}>✕</Button>
        </div>
      ) : (
        <div className={`flex flex-col gap-2 p-2 border-2 border-dashed rounded ${dragOver ? 'border-selected bg-border/30' : 'border-border'}`}>
          {props.linkedId && <Hint className='text-warning'>Linked material is missing from the library — create or link one below.</Hint>}
          <Button variant='success' className='w-full py-2' onClick={create}
            title='Create a reusable material from this node’s current material and edit it'>
            + Create Material
          </Button>
          {materials.length > 0 && (
            <Select value='' onChange={(e) => { if (e.target.value) link(e.target.value) }}>
              <option value=''>Link existing…</option>
              {/* A decal lists every material but can pick only the PBR ones, so the rest read as refused
                  rather than missing. */}
              {materials.map(m => {
                const refused = isDecal && !isProjectableMaterial(m.material)
                return <option key={m.id} value={m.id} disabled={refused}>{refused ? `${m.name} (not PBR)` : m.name}</option>
              })}
            </Select>
          )}
          <Hint>…or drag a material from the <b>Materials</b> tab here.{isDecal && ' A decal projects PBR materials only.'}</Hint>
        </div>
      )}
    </div>
  )
}
