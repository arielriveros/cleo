import React, { useState } from 'react'
import { TextInput, Select, Button, SectionTitle, cn } from '../../components/ui'
import { addGroup, movePart, removeGroup, renameGroup, groupOfPart, type PartGroup, type PartInfo } from '../../utils/submeshGroups'

/** MIME for a sub-mesh chip dragged between group columns. Scoped to this editor — nothing else reads it. */
const PART_MIME = 'text/cleo-import-part'

export interface SubmeshGroupEditorProps {
  parts: PartInfo[]
  bundleName: string
  groups: PartGroup[]
  onChange: (groups: PartGroup[]) => void
}

/**
 * Partition an imported file's sub-meshes into the model assets they will become — one column per asset,
 * chips dragged between them. Shown in ModelImportModal when "separate" and "merge" are both on.
 *
 * Drag is plain HTML5 DnD, deliberately: react-dnd in this editor is confined to the arborist trees
 * behind the per-tree scoped manager in utils/treeDnd, and mounting a second backend from a globally
 * mounted modal is what breaks native drops editor-wide. A per-chip <select> mirrors the drag so the
 * choice is reachable without a mouse.
 */
export default function SubmeshGroupEditor({ parts, bundleName, groups, onChange }: SubmeshGroupEditorProps) {
  const [dragOver, setDragOver] = useState(-1)

  const owner = groupOfPart(groups, parts.length)

  const drop = (e: React.DragEvent, target: number) => {
    e.preventDefault()
    setDragOver(-1)
    const raw = e.dataTransfer.getData(PART_MIME)
    const part = parseInt(raw, 10)
    if (Number.isInteger(part)) onChange(movePart(groups, part, target))
  }

  return (
    <div>
      <div className='flex items-center justify-between mb-1'>
        <SectionTitle title='Groups' />
        <Button size='sm'
                onClick={() => onChange(addGroup(groups, bundleName))}>
          + Add group
        </Button>
      </div>

      <div className='flex gap-2 overflow-x-auto pb-1'>
        {groups.map((group, gi) => (
          <div key={gi}
               onDragOver={(e) => { e.preventDefault(); setDragOver(gi) }}
               onDragLeave={(e) => {
                 // dragleave also fires when the pointer crosses onto a child chip; only a leave that
                 // actually exits the column should clear the highlight, or it strobes.
                 if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                 setDragOver(d => (d === gi ? -1 : d))
               }}
               onDrop={(e) => drop(e, gi)}
               className={cn('w-[168px] shrink-0 rounded border p-2', dragOver === gi ? 'border-primary bg-control' : 'border-control bg-surface-raised')}>
            <div className='flex items-center gap-1 mb-2'>
              <TextInput value={group.name} onChange={(v) => onChange(renameGroup(groups, gi, v))}
                         className='text-ui-sm py-0.5' title='Asset name' />
              {groups.length > 1 && (
                <Button variant='ghost' size='sm' className='shrink-0 px-1' title='Delete group'
                        onClick={() => onChange(removeGroup(groups, gi))}>×</Button>
              )}
            </div>

            <div className='space-y-1'>
              {group.parts.map(pi => (
                <div key={pi} draggable
                     onDragStart={(e) => {
                       e.dataTransfer.setData(PART_MIME, String(pi))
                       e.dataTransfer.effectAllowed = 'move'
                     }}
                     onDragEnd={() => setDragOver(-1)}
                     className='flex items-center gap-1 bg-control rounded px-1.5 py-1 cursor-grab active:cursor-grabbing'>
                  <span className='text-ui-sm truncate flex-1' title={parts[pi]?.name}>{parts[pi]?.name}</span>
                  {groups.length > 1 && (
                    <Select className='text-ui-xs py-0 px-0.5 w-[34px]' value={gi} title='Move to group'
                            draggable={false} onDragStart={(e) => e.stopPropagation()}
                            onChange={(e) => onChange(movePart(groups, pi, parseInt(e.target.value, 10)))}>
                      {groups.map((g, i) => <option key={i} value={i}>{i + 1}</option>)}
                    </Select>
                  )}
                </div>
              ))}
              {group.parts.length === 0 && (
                <p className='text-ui-sm text-dim italic py-2 text-center'>Drop parts here</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* A part belongs to exactly one group by construction; this only fires if that ever breaks. */}
      {owner.some(g => g < 0) && (
        <p className='text-ui-sm text-warning mt-1'>Some parts are not in a group and would be skipped.</p>
      )}
    </div>
  )
}
