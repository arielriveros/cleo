import { useEffect, useMemo, useState } from 'react'
import { Node, Scene } from 'cleo'
import { useEventBus } from '../EventBusContext'
import { Select, cn } from '../../components/ui'

export interface NodeRefInputProps {
  /** Currently referenced node id, or null. */
  value: string | null
  onChange: (id: string | null) => void
  scene: Scene
  /** Narrow the offered nodes — e.g. exclude the referencing node and its own subtree. */
  filter?: (node: Node) => boolean
  placeholder?: string
  disabled?: boolean
  className?: string
}

/**
 * Picks another node in the scene as a property value, either from a dropdown or by dropping a row
 * dragged off the scene tree (tree rows publish their node id as `text/cleo-node`).
 */
export default function NodeRefInput(props: NodeRefInputProps) {
  const eventEmitter = useEventBus()
  const [version, setVersion] = useState(0)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    eventEmitter.on('SCENE_CHANGED', bump)
    return () => { eventEmitter.off('SCENE_CHANGED', bump) }
  }, [eventEmitter])

  const options = useMemo(() => {
    const nodes: Node[] = []
    for (const node of props.scene.nodes) {
      if (node.name === 'root' || !node.parent) continue
      if (node.name.startsWith('__editor__') || node.name.startsWith('__debug__')) continue
      if (props.filter && !props.filter(node)) continue
      nodes.push(node)
    }
    nodes.sort((a, b) => a.name.localeCompare(b.name))

    // Node names are not unique, so duplicates are disambiguated with a short id suffix.
    const nameCounts = new Map<string, number>()
    for (const node of nodes) nameCounts.set(node.name, (nameCounts.get(node.name) ?? 0) + 1)

    return nodes.map(node => ({
      id: node.id,
      label: (nameCounts.get(node.name) ?? 0) > 1 ? `${node.name} (${node.id.slice(0, 4)})` : node.name,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scene, props.filter, version])

  const resolved = props.value ? props.scene.getNodeById(props.value) : null
  const dangling = !!props.value && !resolved

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    const id = event.dataTransfer.getData('text/cleo-node')
    if (!id) return
    const node = props.scene.getNodeById(id)
    if (!node) return
    if (props.filter && !props.filter(node)) return
    props.onChange(id)
  }

  return (
    <div
      className={cn('w-full', props.className)}
      onDragOver={(e) => { if (!props.disabled) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={props.disabled ? undefined : handleDrop}
      title='Pick a node, or drag one from the scene tree'
    >
      <Select
        value={dangling ? '' : (props.value ?? '')}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value || null)}
        className={cn('w-full', dragOver && 'border-primary', dangling && 'border-red-500')}
      >
        <option value=''>{props.placeholder ?? '— None —'}</option>
        {options.map(option => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </Select>
      {dangling &&
        <div className='type-hint text-red-400 mt-1'>
          Missing node ({props.value?.slice(0, 8)})
        </div>
      }
    </div>
  )
}
