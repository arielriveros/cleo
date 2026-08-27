import { useState } from 'react'
import { Node } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { useVfs } from '../../assets/VfsContext'
import Collapsable from '../../../components/Collapsable'
import { Select, Button, Hint, cn, valueClass } from '../../../components/ui'
import { ScriptIcon } from '../sectionIcons'
import { getScriptIdOf, baseTypeMatchesNode, BASE_TYPE_LABEL } from '../../../utils/scripts'
import { templateInstanceRootOf, TEMPLATE_ID_VAR } from '../../../utils/templates'
import { applyAdd, uniquePath, dirOf, KIND_EXT } from '../../../utils/vfs'

// The Script reference control for a node, mirroring MaterialSlot: link, create, drag-drop or detach a script
// asset. `onChanged` lets a host re-read the link after an attach or detach — node mutations do not
// re-render React on their own.
export default function ScriptSlot(props: { node: Node; onChanged: () => void }) {
  const { scriptAssets, createScriptForNode, attachScriptToNode, detachScriptFromNode, enterScriptEditor } = useCleoEngine()
  const { vfs, setVfs } = useVfs()
  const [dragOver, setDragOver] = useState(false)
  const [, force] = useState(0)

  const linkedId = getScriptIdOf(props.node)
  const asset = linkedId ? scriptAssets.find(a => a.id === linkedId) : undefined
  const missing = !!linkedId && !asset
  // Only scripts whose base type can attach to this node are offered.
  const compatible = scriptAssets.filter(a => baseTypeMatchesNode(a.baseType, props.node.nodeType))

  // A template instance's new script lands in the template's folder; every other node's lands at the root.
  const targetFolder = (): string => {
    const root = templateInstanceRootOf(props.node)
    if (!root) return '/'
    const tplId = root.getVariable(TEMPLATE_ID_VAR)
    const entry = vfs.entries.find(e => e.kind === 'template' && e.assetId === tplId)
    return entry ? dirOf(entry.path) : '/'
  }

  const changed = () => { force(x => x + 1); props.onChanged() }

  const handleCreate = () => {
    const created = createScriptForNode(props.node)
    if (!created) return
    // Place the VFS entry here rather than letting the reconciler drop it in whatever folder the explorer is
    // browsing; reconcileVfs keeps an entry that already exists.
    const taken = new Set<string>([...vfs.entries.map(e => e.path), ...vfs.folders])
    const path = uniquePath(taken, targetFolder(), created.name, KIND_EXT.script)
    setVfs(prev => applyAdd(prev, { path, kind: 'script', assetId: created.id, created: Date.now() }))
    changed()
    enterScriptEditor(created.id)
  }

  const handleLink = (id: string) => { if (id && attachScriptToNode(props.node, id)) changed() }
  const handleRemove = () => { detachScriptFromNode(props.node); changed() }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const id = e.dataTransfer.getData('text/cleo-script')
    if (id && attachScriptToNode(props.node, id)) changed()
  }
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/cleo-script')) { e.preventDefault(); setDragOver(true) }
  }

  return (
    <Collapsable title='Script' icon={<ScriptIcon />} persistKey='scriptSlot'>
      <div className='w-full p-2' onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        {asset ? (
          <div className={`flex items-center gap-2 p-2 bg-control border rounded ${dragOver ? 'border-selected' : 'border-border'}`}>
            <span className={cn(valueClass, 'truncate flex-1')} title={`${asset.name} · extends ${BASE_TYPE_LABEL[asset.baseType]}`}>
              {asset.name} <span className='text-dim'>· {BASE_TYPE_LABEL[asset.baseType]}</span>
            </span>
            <Button variant='ghost' size='icon' className='text-highlight' title='Edit this script' onClick={() => enterScriptEditor(asset.id)}>✎</Button>
            <Button variant='ghost' size='icon' className='text-danger' title='Remove the script from this node (keeps the asset)' onClick={handleRemove}>✕</Button>
          </div>
        ) : (
          <div className={`flex flex-col gap-2 p-2 border-2 border-dashed rounded ${dragOver ? 'border-selected bg-border/30' : 'border-border'}`}>
            {missing && <Hint className='text-warning'>Linked script is missing from the library — create or link one below.</Hint>}
            <Button variant='success' className='w-full py-2' onClick={handleCreate}
              title='Create a new class-based script for this node and attach it'>
              + Create Script
            </Button>
            {compatible.length > 0 && (
              <Select value='' onChange={(e) => handleLink(e.target.value)}>
                <option value=''>Link existing…</option>
                {compatible.map(a => (
                  <option key={a.id} value={a.id}>{a.name} · {BASE_TYPE_LABEL[a.baseType]}</option>
                ))}
              </Select>
            )}
            <Hint>…or drag a script from the <b>Assets</b> explorer here.</Hint>
          </div>
        )}
      </div>
    </Collapsable>
  )
}
