import { Node } from 'cleo'
import type { TemplateName } from 'cleo'
import { playDetached } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — a magic bolt. Attach to the root of a projectile template (a plain node with the glowing
 * mesh, a light and a trail particle system beneath it). The firing enemy instantiates it at its hand and
 * calls `launch`.
 *
 * Flight is kinematic: every frame it moves `speed × delta` and sweeps that path twice, so a fast bolt
 * cannot tunnel through anything between two frames:
 *
 *   - a SPHERE of `radius` against the player's hurtbox (`physics.sweepSphere`). During a roll's i-frames
 *     the hurtbox is off (SoulsHitbox), so the sweep sees nothing and the bolt flies on through;
 *   - a ray against the world. Characters are skipped by the ray — the sphere handles them.
 *
 * On impact it spawns an effect and removes itself: `playerImpactTemplate` where it struck the player,
 * `impactTemplate` where it struck the world. It also expires after `lifetime` seconds, bursting where it
 * stopped.
 */
export default class SoulsProjectileNode extends Node {
  public speed: number = 12
  public damage: number = 90
  public poiseDamage: number = 30
  public lifetime: number = 4
  /** The bolt's hitbox: a sphere of this radius swept along its flight. */
  public radius: number = 0.2
  /** The effect where the bolt strikes the world, or runs out of flight. */
  public impactTemplate: TemplateName = 'Bolt Burst'
  /** The effect where it strikes the player. */
  public playerImpactTemplate: TemplateName = 'Bolt Impact'

  private _dir: number[] = [0, 0, 1]
  private _age: number = 0
  private _live: boolean = false
  private _owner: string = ''
  private _gm: Node = null

  onStart() {
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
    if (this._age >= this.lifetime) { this._expire('world'); return }

    const from = this.worldPosition
    const step = this.speed * delta
    const to = [from[0] + this._dir[0] * step, from[1] + this._dir[1] * step, from[2] + this._dir[2] * step]

    // The player's hurtbox, by a swept sphere. Off during i-frames, so a roll passes straight through.
    const physics = this.scene?.physics as any
    const hits = physics?.sweepSphere?.([from[0], from[1], from[2]], to, this.radius, {
      filter: (node: Node) => !!node && node.id !== this._owner && (node as any).team === 'player'
        && typeof (node as any).receiveHit === 'function' && (node as any).hurtboxActive !== false && !(node as any).isDead,
    }) ?? []
    for (const h of hits) {
      if ((h.node as any).receiveHit(this.damage, this.poiseDamage, this)) {
        this.setPosition([h.point[0], h.point[1], h.point[2]])
        this._expire('player')
        return
      }
    }

    // The world, by raycast. Characters are skipped — the sweep above handles them.
    const hit = physics?.raycast?.([from[0], from[1], from[2]], to, {
      reject: (owner: Node) => !!owner && (owner.id === this._owner || owner.nodeType === 'character'
        || owner === this || owner.isDescendantOf?.(this)),
    })
    if (hit) {
      this.setPosition([hit.point[0], hit.point[1], hit.point[2]])
      this._expire('world')
      return
    }
    this.setPosition(to)
  }

  private _expire(on: 'player' | 'world'): void {
    this._live = false
    const gm = this._gm as any
    gm?.fx?.(on === 'player' ? this.playerImpactTemplate : this.impactTemplate, this.worldPosition)
    playDetached(this, 'Bolt Impact')
    // Immediate: the impact effect takes its place this frame.
    this.remove({ immediate: true })
  }
}
