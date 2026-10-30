import { useEffect, useRef } from 'react'
import { markEditorOwned, type Node } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useRig } from '../rig/RigContext'
import { getAnimationTarget } from '../animation/skeleton'
import { instantiateModelAsset, modelIdOf } from '../../utils/models'
import { runtimeSockets, type RigSocket } from '../../utils/rigAssets'

// Socket previews for the animation editors: the rig's sockets applied to the previewed character, and
// each socket's preview model riding on it — so a sword can be checked against a swing without placing
// either in a scene.
//
// The preview models are editor-OWNED children of the preview scene and follow their socket through the
// ordinary scene socket pass. Nothing here is ever saved: every editor that mounts this works on a
// throwaway preview scene, and an owned node is left out of serialization regardless.

type Spawned = { modelId: string; node: Node }

export default function SocketPreviews({ targetId }: { targetId?: string | null }) {
  const { editorScene, skeletonTargetId, editorMode, withoutDirty } = useCleoEngine()
  const { rigs, models, materials, animations } = useAssetLibrary()
  const { asset: workingRig } = useRig()
  const spawnedRef = useRef(new Map<string, Spawned>())

  const target = getAnimationTarget(editorScene, targetId ?? skeletonTargetId)
  // The rig tab edits a WORKING COPY, which is what must show; everywhere else, the saved rig of the
  // model being previewed.
  const modelAsset = target ? models.find(m => m.id === modelIdOf(target.node)) : undefined
  const rig = editorMode === 'rig' ? workingRig : rigs.find(r => r.id === modelAsset?.rigId)
  const sockets: RigSocket[] = rig?.sockets ?? []
  const key = JSON.stringify(sockets)

  useEffect(() => {
    if (!target) return
    // Live sockets on the preview skin. A fresh array, so the runtime's identity-keyed cache re-resolves.
    const live = runtimeSockets(sockets)
    target.skin.sockets = live.length ? live : undefined

    const spawned = spawnedRef.current
    const scene = target.node.scene
    const parent = target.node.parent ?? scene?.root
    if (!scene || !parent) return

    const drop = (id: string) => {
      const entry = spawned.get(id)
      if (!entry) return
      spawned.delete(id)
      try { withoutDirty(() => scene.removeNode(entry.node)) } catch { /* the preview scene may be gone */ }
    }

    for (const id of Array.from(spawned.keys())) {
      const socket = sockets.find(s => s.id === id)
      const entry = spawned.get(id)!
      if (!socket || socket.previewModelId !== entry.modelId || !entry.node.scene) drop(id)
    }

    for (const socket of sockets) {
      if (!socket.previewModelId) continue
      const existing = spawned.get(socket.id)
      if (existing) {
        // A rename re-points the follower in place rather than respawning the model.
        if (existing.node.socketAttachment?.socket !== socket.name) {
          withoutDirty(() => { existing.node.socketAttachment = { target: target.node.id, socket: socket.name } })
        }
        continue
      }
      const model = models.find(m => m.id === socket.previewModelId)
      if (!model) continue
      withoutDirty(() => {
        const rootId = instantiateModelAsset(model, parent, materials, models, animations)
        const node = scene.getNodeById(rootId)
        if (!node) return
        markEditorOwned(node)
        node.socketAttachment = { target: target.node.id, socket: socket.name }
        spawned.set(socket.id, { modelId: model.id, node })
      })
    }
  // `key` stands in for `sockets`: the working copy is a new object on every edit, equal or not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, target?.node.id, editorScene])

  // Take every preview model down with the editor that showed it. Keyed on the scene ONLY: `withoutDirty`
  // is a new function on every render, and as a dependency it ran this cleanup after every render —
  // removing each preview a frame after it was spawned.
  const withoutDirtyRef = useRef(withoutDirty)
  withoutDirtyRef.current = withoutDirty
  useEffect(() => () => {
    for (const { node } of spawnedRef.current.values()) {
      try { withoutDirtyRef.current(() => node.scene?.removeNode(node)) } catch { /* scene already disposed */ }
    }
    spawnedRef.current.clear()
  }, [editorScene])

  return null
}
