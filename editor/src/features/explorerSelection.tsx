import React, { useCallback, useEffect, useState } from 'react'

// Shared multi-select for the asset explorers (Textures / Templates / Materials / Meshes). Click a card to
// toggle it; when more than one is selected the BatchDeleteBar shows a red trash for confirm-then-delete.

export function useMultiSelect(validIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Prune ids that no longer exist (per-card delete, list refresh) so the count/selection stay accurate.
  const key = validIds.join('|')
  useEffect(() => {
    setSelected(prev => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) { if (validIds.includes(id)) next.add(id); else changed = true }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const toggle = useCallback((id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])
  const clear = useCallback(() => setSelected(new Set()), [])
  const has = useCallback((id: string) => selected.has(id), [selected])

  return { selected, toggle, clear, has }
}

// Right-aligned batch toolbar. Renders nothing unless more than one item is selected.
export function BatchDeleteBar({ count, noun, onDelete, onClear }: {
  count: number
  noun: string
  onDelete: () => void
  onClear: () => void
}) {
  if (count <= 1) return null
  return (
    <div className='flex items-center gap-2 ml-auto'>
      <span className='text-[11px] text-gray-300'>{count} selected</span>
      <button className='text-red-400 hover:text-red-300 text-sm' title={`Delete ${count} selected ${noun}`} onClick={onDelete}>🗑</button>
      <button className='text-gray-400 hover:text-gray-200 text-xs' title='Clear selection' onClick={onClear}>✕</button>
    </div>
  )
}
