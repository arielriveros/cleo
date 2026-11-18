import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mat4, quat, vec3 } from 'gl-matrix'
import { Animator } from 'cleo'
import { rememberPreviewHome, returnPreviewHome } from '../src/features/clip/previewHome'

// A root-motion clip moves the preview character's model node ITSELF (a preview has no body for root motion to
// move instead), so one turn played in the Clip Player used to leave the character turned and moved off for every
// clip after it, until the tab was closed. The transports remember where it stands and put it back.

const SKIN = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], nodeTransforms: new Map([[0, mat4.create()]]) }

/** A turn: the root bone walking 1 m along +X and turning 90 degrees about Y over a second, as root motion. */
const TURN = {
  name: 'Turn', rootMotion: true,
  samplers: [
    { input: [0, 1], output: [0, 0, 0, 1, 0, 0], interpolation: 'LINEAR' },
    { input: [0, 1], output: [0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2], interpolation: 'LINEAR' },
  ],
  channels: [
    { samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' },
    { samplerIndex: 1, targetNodeIndex: 0, targetPath: 'rotation' },
  ],
}

/** The model node, as far as the animator's root motion and the preview home touch it: parentless, no body. */
function previewNode() {
  const position = vec3.fromValues(2, 0, -3), quaternion = quat.create()
  return {
    position, quaternion, worldPosition: position, worldQuaternion: quaternion, parent: null, body: null, ownBody: null,
    worldTransform: mat4.create(), currentSpeed: 0,
    setPosition(v: ArrayLike<number>) { vec3.copy(position, v as vec3) },
    setQuaternion(q: ArrayLike<number>) { quat.copy(quaternion, q as quat) },
    setWorldPosition(v: ArrayLike<number>) { vec3.copy(position, v as vec3) },
    setWorldQuaternion(q: ArrayLike<number>) { quat.copy(quaternion, q as quat) },
  }
}

describe('the clip preview character comes home', () => {
  it('stands where it stood before a root-motion clip played, once put back', () => {
    const node = previewNode()
    const animator = new Animator({ skin: SKIN, animations: [TURN] } as any, node as any)
    rememberPreviewHome(node as any)
    animator.playAnimationByName('Turn', false, false)
    for (let k = 0; k < 30; k++) animator.update(1 / 60)
    // The turn did move it: that is the leak.
    expect(vec3.distance(node.position, [2, 0, -3])).toBeGreaterThan(0.2)
    expect(Math.abs(quat.getAngle(node.quaternion, quat.create()))).toBeGreaterThan(0.3)
    returnPreviewHome(node as any)
    expect(Array.from(node.position)).toEqual([2, 0, -3])
    expect(quat.getAngle(node.quaternion, quat.create())).toBeLessThan(1e-6)
  })

  it('keeps the first home it was given', () => {
    const node = previewNode()
    rememberPreviewHome(node as any)
    node.setPosition([5, 0, 5])
    rememberPreviewHome(node as any)   // a second transport mounting after a clip moved it
    returnPreviewHome(node as any)
    expect(Array.from(node.position)).toEqual([2, 0, -3])
  })

  it('is put back by both transports on stop, on a clip change, on a scrub, on a loop and on the way out', () => {
    const read = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf-8').replace(/\r\n/g, '\n')
    const clip = read('features', 'clip', 'ClipTimeline.tsx')
    expect(clip).toContain('const onStop = () => { animator.stop(); animator.showBindPose(); returnPreviewHome(target.node);')
    expect(clip).toMatch(/const bind = \(name: string\) => \{\s+returnPreviewHome\(target\.node\)/)
    expect(clip).toMatch(/const onScrub = \(v: number\) => \{[\s\S]{0,200}returnPreviewHome\(target\.node\)/)
    expect(clip).toContain('if (t.animator.loop && t.animator.currentTime < before) returnPreviewHome(t.node)')
    expect(clip).toMatch(/useEffect\(\(\) => \(\) => \{[\s\S]{0,200}if \(t\) returnPreviewHome\(t\.node\)/)
    // A clip change rebinding the preview starts at home too.
    expect(clip).toMatch(/rememberPreviewHome\(target\.node\)\s+returnPreviewHome\(target\.node\)\s+const bound = applyPreviewClips/)
    const player = read('features', 'animation', 'AnimationPlayer.tsx')
    expect(player).toMatch(/const onStop = \(\) => \{\s+animator\.stop\(\)\s+animator\.showBindPose\(\)\s+returnPreviewHome\(target\.node\)/)
    expect(player).toMatch(/const selectClip = \(name: string\) => \{\s+returnPreviewHome\(target\.node\)/)
    expect(player).toContain('return () => { target.animator.showBindPose(); returnPreviewHome(target.node) }')
    // The tab's builder remembers it before anything plays.
    expect(read('features', 'hooks', 'useClipEditor.ts')).toContain('if (skinned) rememberPreviewHome(skinned);')
  })
})
