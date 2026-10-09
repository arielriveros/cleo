import { useEffect, useRef, useState } from 'react'
import { mat4, quat, vec3 } from 'gl-matrix'
import { Node, decomposeTRS, markEditorOwned, socketJoint } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useRig } from '../rig/RigContext'
import { getAnimationTarget } from '../animation/skeleton'
import { SELECT_SOCKET } from '../rig/SocketsPanel'
import TransformGizmo from '../gizmo/TransformGizmo'
import type { TransformPatch } from '../gizmo/gizmoDrag'

/**
 * Dragging a socket's offset with the transform gizmo, in the rig editor.
 *
 * The same proxy trick as `BoneGizmo`: an invisible, editor-owned node is parked on the selected socket,
 * the gizmo drags it, and the result is solved back into the socket's offset:
 *
 *     socketWorld = modelWorld x TR(jointModel) x offset
 *     offset      = inverse(modelWorld x TR(jointModel)) x gizmoWorld
 *
 * `TR(jointModel)` — the joint without its scale — because that is how the runtime places a socket (see
 * `socketModelMatrix`): an armature's 0.01 must not shrink what the socket holds.
 */
const SOCKET_GIZMO_PROXY_NAME = '__editor__socketGizmoProxy'

export default function SocketGizmo({ viewportRef }: { viewportRef: React.RefObject<HTMLDivElement> }) {
  const { editorScene, mainScene, skeletonTargetId, eventEmitter, withoutDirty } = useCleoEngine()
  const { asset, patch } = useRig()
  const [socketId, setSocketId] = useState<string | null>(null)
  const [proxyId, setProxyId] = useState<string | null>(null)
  const proxyRef = useRef<Node | null>(null)
  const draggingRef = useRef(false)
  const dragStartScaleRef = useRef<number[]>([1, 1, 1])
  // Latest working copy for the drag handler, which outlives renders.
  const assetRef = useRef(asset)
  assetRef.current = asset

  useEffect(() => {
    const onSocket = (id: string | null) => setSocketId(id ?? null)
    eventEmitter.on(SELECT_SOCKET, onSocket)
    return () => { eventEmitter.off(SELECT_SOCKET, onSocket) }
  }, [eventEmitter])

  useEffect(() => {
    if (!editorScene || editorScene === mainScene) return
    const proxy = markEditorOwned(new Node(SOCKET_GIZMO_PROXY_NAME))
    withoutDirty(() => editorScene.addNode(proxy))
    proxyRef.current = proxy
    setProxyId(proxy.id)
    return () => {
      proxyRef.current = null
      setProxyId(null)
      try { withoutDirty(() => editorScene.removeNode(proxy)) } catch { /* scene gone with the tab */ }
    }
  }, [editorScene, mainScene])

  const socket = asset?.sockets?.find(s => s.id === socketId)

  /** `modelWorld x TR(jointModel)` for the selected socket's bone, or null. */
  const boneFrame = (): mat4 | null => {
    const target = getAnimationTarget(editorScene, skeletonTargetId)
    const s = assetRef.current?.sockets?.find(x => x.id === socketId)
    if (!target || !s) return null
    const joint = socketJoint(target.skin, s.name)
    const jointModel = joint >= 0 ? target.animator.getJointModelMatrix(joint) : null
    if (!jointModel) return null
    const t = vec3.create(), r = quat.create()
    decomposeTRS(jointModel, t, r, vec3.create())
    return mat4.multiply(mat4.create(), target.node.worldTransform, mat4.fromRotationTranslation(mat4.create(), r, t))
  }

  // Park the proxy on the socket, except mid-drag when the gizmo owns it.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const proxy = proxyRef.current
      const target = getAnimationTarget(editorScene, skeletonTargetId)
      const s = assetRef.current?.sockets?.find(x => x.id === socketId)
      if (proxy && target && s && !draggingRef.current) {
        const world = target.node.getSocketWorldMatrix(s.name)
        if (world) {
          const t = vec3.create(), r = quat.create()
          decomposeTRS(world, t, r, vec3.create())
          proxy.setPosition(t as any)
          proxy.setQuaternion(r as any)
          proxy.setScale([1, 1, 1] as any)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [editorScene, skeletonTargetId, socketId])

  useEffect(() => {
    const up = () => { draggingRef.current = false }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  const onTransformChange = (_nodeId: string, change: TransformPatch) => {
    const proxy = proxyRef.current
    const rig = assetRef.current
    const s = rig?.sockets?.find(x => x.id === socketId)
    if (!proxy || !rig || !s) return
    if (!draggingRef.current) dragStartScaleRef.current = s.offset?.s ?? [1, 1, 1]
    draggingRef.current = true

    if (change.kind === 'position') proxy.setPosition(change.local as any)
    else if (change.kind === 'scale') proxy.setScale(change.local as any)
    else proxy.setQuaternion(change.localQuat as any)
    proxy.updateTransforms?.()

    const frame = boneFrame()
    const inv = frame ? mat4.invert(mat4.create(), frame) : null
    if (!inv) return
    const world = mat4.fromRotationTranslation(mat4.create(),
      quat.normalize(quat.create(), proxy.quaternion as any), proxy.position as any)
    const local = mat4.multiply(mat4.create(), inv, world)
    const t = vec3.create(), r = quat.create()
    decomposeTRS(local, t, r, vec3.create())
    const start = dragStartScaleRef.current
    const sc = change.kind === 'scale'
      ? [start[0] * change.local[0], start[1] * change.local[1], start[2] * change.local[2]]
      : start

    const offset = { t: [t[0], t[1], t[2]], r: [r[0], r[1], r[2], r[3]], s: sc }
    patch({ ...rig, sockets: rig.sockets!.map(x => (x.id === s.id ? { ...x, offset } : x)) })
  }

  if (!proxyId || !socket) return null
  return <TransformGizmo selectedNodeId={proxyId} onTransformChange={onTransformChange} viewportRef={viewportRef} />
}
