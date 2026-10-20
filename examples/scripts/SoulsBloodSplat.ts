import { Node } from 'cleo'
import { clamp, num } from '@/Core/Scripts/SoulsMath'

/**
 * Hollow Keep — a blood decal on the ground. Attach to the root of a template whose children include
 * Decal nodes (`Blood Splat`, `Blood Drops`); the GameManager instantiates one where a hit lands and
 * sets `yaw` and `sizeScale` on it (see `bleed`).
 *
 * On its first frame it finds the floor below with a raycast, moves there and tilts so its decals
 * project straight into the surface — a ramp included — then gives them a random size. It removes
 * itself when there is no floor in reach: blood is never left hanging over a drop. After `lifetime`
 * it fades out over `fadeSeconds` and is removed.
 *
 * Placement waits for the first update rather than onStart, so the spawner's `yaw` and `sizeScale` are
 * in place whichever runs first; the decals stay invisible until then.
 */
export default class SoulsBloodSplatNode extends Node {
  /** Seconds before the splat is gone, its fade included. */
  public lifetime: number = 12
  /** The last part of `lifetime`, over which the decals fade out. */
  public fadeSeconds: number = 3
  /** Random size range, as a multiple of each decal's authored size. */
  public minSize: number = 0.65
  public maxSize: number = 1.25
  /** How far below the spawn point the floor may be. */
  public snapDown: number = 2.5
  /** Tilt onto sloped ground. Off, the splat lies flat and the decal's angle fade handles the slope. */
  public alignToSurface: boolean = true
  /** Set by the spawner. Which way the decal's +Z points, in degrees; NaN for a random turn. */
  public yaw: number = NaN
  /** Set by the spawner: a bigger hit leaves a bigger splat. */
  public sizeScale: number = 1

  private _age: number = 0
  private _placed: boolean = false
  private _decals: any[] = []
  private _sizes: number[][] = []

  onStart() {
    this._decals = this.children.filter(c => c.nodeType === 'decal')
    this._sizes = this._decals.map(d => [...d.size])
    for (const d of this._decals) d.opacity = 0
  }

  onUpdate(delta: number) {
    if (!this._placed) {
      this._placed = true
      if (!this._place()) { this.remove({ immediate: true }); return }
    }
    this._age += delta
    const fade = Math.max(0.01, this.fadeSeconds)
    const k = clamp((this.lifetime - this._age) / fade, 0, 1)
    for (const d of this._decals) d.opacity = k
    // Its own opacity fade has already run; nothing is left to dissolve.
    if (this._age >= this.lifetime) this.remove({ immediate: true })
  }

  /** Snap onto the floor below, turn, size. False when there is no floor in reach. */
  private _place(): boolean {
    // Spawned this frame, its world matrix may not have been computed yet: do it now, from the parent's.
    this.updateTransforms(this.parent ? this.parent.worldTransform : null)
    const p = this.worldPosition
    const physics = this.scene?.physics as any
    const hit = physics?.raycast?.([p[0], p[1] + 0.5, p[2]], [p[0], p[1] - this.snapDown, p[2]], {
      reject: (owner: Node) => isCharacterPart(owner),
    })
    if (!hit) return false

    const yaw = Number.isFinite(this.yaw) ? this.yaw : Math.random() * 360
    const n = hit.normal
    // Local +Y onto the surface normal: rotations compose Ry(yaw)·Rx(pitch), and Rx(p)·(0,1,0) turned by
    // Ry(y) is (sin p sin y, cos p, sin p cos y). A floor has no tilt, so its yaw stays free for the turn.
    const tilt = this.alignToSurface ? Math.acos(clamp(n[1], -1, 1)) * 180 / Math.PI : 0
    const rotation: [number, number, number] = tilt > 2
      ? [tilt, Math.atan2(n[0], n[2]) * 180 / Math.PI, 0]
      : [0, yaw, 0]
    this.setPosition([hit.point[0], hit.point[1], hit.point[2]])
    this.setRotation(rotation)

    const scale = num(this.sizeScale, 1) * (this.minSize + Math.random() * Math.max(0, this.maxSize - this.minSize))
    this._decals.forEach((d, i) => {
      const s = this._sizes[i]
      // Height stays: it is how far the projection reaches, not how big the splat looks.
      d.size = [s[0] * scale, s[1], s[2] * scale]
      d.opacity = 1
    })
    return true
  }
}

/** A character, or anything inside one (a ragdolled limb): blood lands on the floor, not on a body. */
function isCharacterPart(owner: Node): boolean {
  for (let n: Node = owner; n; n = n.parent) if (n.nodeType === 'character') return true
  return false
}
