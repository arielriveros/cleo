import { Node } from 'cleo'

/**
 * Hollow Keep — a magic bolt. Attach to the root of a projectile template (a plain node with the glowing
 * mesh, a light and a trail particle system beneath it). The firing enemy instantiates it at its hand and
 * calls `launch`.
 *
 * Flight is kinematic: every frame it moves `speed × delta` and sweeps that SEGMENT with a raycast, so a
 * fast bolt cannot tunnel through a thin wall between two frames. Characters are skipped by the ray and
 * tested by distance instead, which is what lets a roll's i-frames work: the player's `receiveDamage`
 * returns false while invulnerable and the bolt simply carries on through.
 *
 * On impact it spawns `impactTemplate` and removes itself; it also expires after `lifetime` seconds.
 */
export default class SoulsProjectileNode extends Node {
  public speed: number = 12
  public damage: number = 90
  public poiseDamage: number = 30
  public lifetime: number = 4
  /** Hit radius against the player's chest. */
  public radius: number = 0.45
  /** Height above the player's feet the bolt is tested against. */
  public chestHeight: number = 1.1
  public impactTemplate: string = 'Bolt Impact'

  private _dir: number[] = [0, 0, 1]
  private _age: number = 0
  private _live: boolean = false
  private _owner: string = ''
  private _player: Node = null
  private _gm: Node = null
  private _passed: boolean = false

  onStart() {
    this._player = this.findNode('Player')
    this._gm = this.findNode('GameManager')
  }

  /** Fire along `dir` (normalised here). Called by SoulsEnemy right after instantiating. */
  public launch(dir: number[], speed: number, damage: number, ownerId: string): void {
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1
    this._dir = [dir[0] / len, dir[1] / len, dir[2] / len]
    this.speed = speed
    this.damage = damage
    this._owner = ownerId
    this._age = 0
    this._live = true
    this.setRotation([0, Math.atan2(this._dir[0], this._dir[2]) * 180 / Math.PI, 0])
  }

  onUpdate(delta: number) {
    if (!this._live) return
    this._age += delta
    if (this._age >= this.lifetime) { this._expire(false); return }

    const from = this.worldPosition
    const step = this.speed * delta
    const to = [from[0] + this._dir[0] * step, from[1] + this._dir[1] * step, from[2] + this._dir[2] * step]

    // The player, by distance to the swept segment.
    const player = this._player as any
    if (player && !player.isDead && !this._passed) {
      const p = this._player.worldPosition
      const chest = [p[0], p[1] + this.chestHeight, p[2]]
      if (segmentDistance(from, to, chest) <= this.radius) {
        if (player.receiveDamage?.(this.damage, this.poiseDamage, this)) {
          this._expire(true)
          return
        }
        // Rolled through it: never test this player again, or it would hit on the way out.
        this._passed = true
      }
    }

    // The world, by raycast. Characters are skipped — they were handled above.
    const physics = this.scene?.physics as any
    const hit = physics?.raycast?.([from[0], from[1], from[2]], to, {
      reject: (owner: Node) => !!owner && (owner.id === this._owner || owner.nodeType === 'character'
        || owner === this || owner.isDescendantOf?.(this)),
    })
    if (hit) {
      this.setPosition([hit.point[0], hit.point[1], hit.point[2]])
      this._expire(true)
      return
    }
    this.setPosition(to)
  }

  private _expire(impact: boolean): void {
    this._live = false
    if (impact) {
      const gm = this._gm as any
      gm?.fx?.(this.impactTemplate, this.worldPosition)
      gm?.sfx?.('Bolt Impact')
    }
    this.remove()
  }
}

/** Distance from point `p` to the segment `a`→`b`. */
function segmentDistance(a: ArrayLike<number>, b: ArrayLike<number>, p: ArrayLike<number>): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0
  const c = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]
  return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])
}
