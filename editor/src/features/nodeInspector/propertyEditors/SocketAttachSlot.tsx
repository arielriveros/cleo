import { useEffect, useState } from 'react'
import { ModelNode, type Node } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { Hint, Select, cn, sectionTitleClass } from '../../../components/ui'

// "Attach to socket": pin any node to a socket on a character's skeleton — the sword in the hand.
//
// The usual case is a node dropped under the character, so the default target is the nearest skinned
// model ABOVE it (the engine also looks inside each ancestor, because a character is a holder with its
// meshes beneath). An explicit character is for an item held by someone it is not parented to.

/** Skinned models with sockets in `root`'s subtree, nearest first, never inside `exclude`. */
function socketModelsIn(root: Node, exclude: Node, out: ModelNode[]): void {
  const queue: Node[] = [root]
  while (queue.length) {
    const n = queue.shift()!
    if (n === exclude) continue
    if (n instanceof ModelNode && n.socketNames.length && !out.includes(n)) out.push(n)
    queue.push(...n.children)
  }
}

export default function SocketAttachSlot({ node }: { node: Node }) {
  const { editorScene: activeScene } = useCleoEngine()
  const [, force] = useState(0)
  // The node is mutated in place; re-read whenever another node is selected.
  useEffect(() => { force(x => x + 1) }, [node])

  const attachment = node.socketAttachment

  // Candidates above (for 'parent') and everywhere (for an explicit target).
  const above: ModelNode[] = []
  for (let a = node.parent; a; a = a.parent) socketModelsIn(a, node, above)
  const everywhere: ModelNode[] = []
  if (activeScene) socketModelsIn(activeScene.root, node, everywhere)

  if (!attachment && !above.length && !everywhere.length) return null

  const targetValue = attachment?.target ?? 'parent'
  const owners = targetValue === 'parent'
    ? above
    : everywhere.filter(m => m.id === targetValue || isAncestorOf(activeScene?.getNodeById(targetValue), m))
  const socketNames = Array.from(new Set(owners.flatMap(m => m.socketNames)))
  const missing = !!attachment && !socketNames.includes(attachment.socket)

  const set = (target: string, socket: string) => {
    node.socketAttachment = socket ? { target, socket } : null
    force(x => x + 1)
  }

  return (
    <div className='px-2'>
      <div className={cn(sectionTitleClass, 'mt-3 mb-1')}>Attach to socket</div>
      <div className='flex flex-col gap-1'>
        <Select
          value={targetValue}
          title='Whose skeleton to follow'
          onChange={e => set(e.target.value, attachment?.socket ?? '')}
        >
          <option value='parent'>Nearest character above</option>
          {everywhere.map(m => <option key={m.id} value={m.id}>{characterLabel(m)}</option>)}
        </Select>
        <Select
          value={attachment?.socket ?? ''}
          onChange={e => set(targetValue, e.target.value)}
        >
          <option value=''>Not attached</option>
          {missing && <option value={attachment!.socket}>{attachment!.socket} (not found)</option>}
          {socketNames.map(n => <option key={n} value={n}>{n}</option>)}
        </Select>
        {attachment && !missing && (
          <Hint>Follows the bone every frame, so this node’s own transform is overwritten while attached.</Hint>
        )}
        {missing && (
          <Hint className='text-warning'>
            No character in reach has this socket, so the node stays where it is. Add it in the rig editor.
          </Hint>
        )}
        {!socketNames.length && !missing && (
          <Hint>No sockets on {targetValue === 'parent' ? 'the character above' : 'that character'} yet — add them in its rig.</Hint>
        )}
      </div>
    </div>
  )
}

function isAncestorOf(a: Node | undefined, n: Node): boolean {
  for (let p: Node | null = n; p; p = p.parent) if (p === a) return true
  return false
}

/** A model node named by the character it belongs to: a mesh called "Body" says nothing on its own. */
function characterLabel(m: ModelNode): string {
  const holder = m.parent && m.parent.parent ? m.parent : null
  return holder && holder.name !== m.name ? `${holder.name} / ${m.name}` : m.name
}
