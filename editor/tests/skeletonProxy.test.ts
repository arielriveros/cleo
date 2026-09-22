import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isEditorOwnedName, setGLContext, setDevice, WebGL2Device } from 'cleo'
import { bindPoseBounds, buildSkeletonProxy, SKELETON_PROXY_NAME } from '../src/features/demoScene/skeletonProxy'
import { getAnimationTarget } from '../src/features/animation/skeleton'
import type { StoredSkin } from '../src/utils/animationAssets'

// A rig no model uses must still show its bones: the tabs draw them through a skinned node, and without
// one they logged "showing the skeleton on its own" over an empty stage.

// An AnimatedModel builds its mesh eagerly, so the proxy needs something to hand its buffers to. The
// stubbed context the preview tests use serves here too.
beforeAll(() => {
  let n = 0
  const constants: Record<string, number> = {
    UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
  }
  const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture'])
  const gl = new Proxy({}, {
    get: (_t, key: string) => (key in constants ? constants[key] : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
  })
  setGLContext(gl as any)
  setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext))
})

const translation = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]

/** Two joints 180 units apart: a centimetre skeleton, the case the fixed metre-box framing lost. */
const skin: StoredSkin = {
  name: 'cm',
  joints: [
    { nodeIndex: 0, inverseBindMatrix: translation(0, 0, 0) },
    // Joint 1 sits at y = 180, so its INVERSE bind matrix translates by -180.
    { nodeIndex: 1, inverseBindMatrix: translation(0, -180, 0), parentIndex: 0 },
  ],
  skeleton: 0,
  nodeParents: [[1, 0]],
  nodeTransforms: [[0, translation(0, 0, 0)], [1, translation(0, 180, 0)]],
  nodeNames: [[0, 'Hips'], [1, 'Head']],
} as any

describe('the skeleton proxy', () => {
  it('frames the bind pose, whatever the unit', () => {
    const proxy = buildSkeletonProxy(skin)!
    expect(proxy.center[1]).toBeCloseTo(90)
    expect(proxy.radius).toBeCloseTo(90)
  })

  it('is a skinned node the bone overlay can read', () => {
    const proxy = buildSkeletonProxy(skin)!
    const scene = { getNodeById: (id: string) => (id === proxy.node.id ? proxy.node : null) } as any
    const target = getAnimationTarget(scene, proxy.node.id)
    expect(target).not.toBeNull()
    expect(target!.skin.joints).toHaveLength(2)
  })

  it('is editor-owned and not mistaken for a gizmo', () => {
    expect(isEditorOwnedName(SKELETON_PROXY_NAME)).toBe(true)
    expect(SKELETON_PROXY_NAME.toLowerCase()).not.toContain('gizmo')
  })

  it('is null for a skin with no joints', () => {
    expect(buildSkeletonProxy({ ...skin, joints: [] } as any)).toBeNull()
    expect(buildSkeletonProxy(null)).toBeNull()
    expect(bindPoseBounds({ joints: [] })).toBeNull()
  })

  it('is what the rig and clip tabs fall back to', () => {
    for (const hook of ['useRigEditor.ts', 'useClipEditor.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', 'features', 'hooks', hook), 'utf8')
      expect(src, hook).toMatch(/buildSkeletonProxy\(/)
      expect(src, hook).toMatch(/withoutDirty\(\(\) => holder\.addChild\(proxy\.node\)\)/)
    }
  })
})
