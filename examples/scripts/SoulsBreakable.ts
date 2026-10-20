import { Node } from 'cleo'
import type { TemplateName } from 'cleo'
import { playDetached } from '@/Core/Scripts/SoulsAudio'

/**
 * A prop that shatters: struck by the player's swing, or rolled into, it swaps itself for a pile of
 * physics debris (a separate template, `debrisTemplate`) and dissolves away. Attach to the root of
 *
 *   Breakable Barrel     this script + a STATIC body (it blocks like any prop) + a trigger a little
 *   ├── Mesh             wider than the body (how a roll is noticed before the body stops it)
 *   └── Sounds           Break
 *
 * It is a HURTBOX for the player's swings -- `team = 'enemy'` and `receiveHit` are what SoulsHitbox
 * looks for -- without being an enemy: nothing registers it with the manager, so lock-on, the HUD and
 * the enemy count never see it. Not `blocksSwings`: a blade that bounced off it could never break it.
 */
export default class SoulsBreakableNode extends Node {
  /** The template spawned in its place, one physics body per piece. See SoulsDebris. */
  public debrisTemplate: TemplateName = 'Barrel Debris'
  /** Metres per second the pieces leave at, along the blow. */
  public breakSpeed: number = 3.5
  /** A roll breaks it only this fast or faster (metres per second). */
  public rollBreakSpeed: number = 2
  public breakSound: string = 'Break'
  public team: string = 'enemy'
  public isBreakable: boolean = true
  public isBroken: boolean = false
  public hurtboxActive: boolean = true

  private _inside: Node[] = []

  /** SoulsHitbox's damage hook: any hit breaks it, pushed away from whoever struck. */
  public receiveHit(_damage: number, _poise: number, from: Node): boolean {
    if (this.isBroken) return false
    const me = this.worldPosition
    const at = from ? from.worldPosition : me
    this.shatter([me[0] - at[0], 0.6, me[2] - at[2]])
    return true
  }

  onTriggerEnter(other: Node) {
    if (other && !this._inside.includes(other)) this._inside.push(other)
  }

  onTriggerExit(other: Node) {
    this._inside = this._inside.filter(n => n !== other)
  }

  onUpdate() {
    if (this.isBroken) return
    // Rolled into: the player is inside the zone mid-roll and actually moving.
    for (const n of this._inside) {
      const p = n as any
      if (p.actionState !== 'roll') continue
      const v = p.velocity as ArrayLike<number> | undefined
      if (v && Math.hypot(v[0], v[2]) < this.rollBreakSpeed) continue
      this.shatter(v ? [v[0], 0.4, v[2]] : [0, 0.4, 0])
      return
    }
  }

  /**
   * Break now, the pieces leaving along `push` (any length; its direction is used). Spawns the debris
   * where this stands, then removes itself -- which dissolves whatever is left of it (see Node.remove).
   */
  public shatter(push: ArrayLike<number> = [0, 0.5, 0]): void {
    if (this.isBroken) return
    this.isBroken = true
    this.hurtboxActive = false
    const len = Math.hypot(push[0], push[1], push[2]) || 1
    const velocity = [push[0] / len * this.breakSpeed, push[1] / len * this.breakSpeed, push[2] / len * this.breakSpeed]

    const scene = this.scene as any
    const at = Array.from(this.worldPosition)
    const rot = Array.from(this.rotation as ArrayLike<number>)
    let debris: any = null
    try { debris = scene?.instantiate?.(this.debrisTemplate, { position: at, rotation: rot }) } catch { debris = null }
    debris?.burst?.(velocity)

    playDetached(this, this.breakSound)
    // Its own body and mesh go at once -- the debris stands exactly where they were.
    this.remove({ immediate: true })
  }
}
