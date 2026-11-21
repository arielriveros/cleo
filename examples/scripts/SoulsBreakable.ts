import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
import type { SoundName, TemplateName } from 'cleo'
import { playDetached } from '@/Core/Scripts/SoulsAudio'

/**
 * A prop that shatters: struck by the player's swing, or rolled into, it swaps itself for a pile of
 * physics debris (a separate template, `debrisTemplate`) and dissolves away. Attach to the root of
 *
 *   Breakable Barrel     this script + a STATIC body (it blocks like any prop) + a trigger a little
 *   ├── Mesh             wider than the body (how a roll is noticed before the body stops it)
 *   ├── Hurtbox          a trigger the size of the body, in the enemy hurtbox layer: what a blade hits
 *   └── Sounds           Break
 *
 * It is a target for the player's swings -- `team = 'enemy'`, `receiveHit` and its Hurtbox are what
 * SoulsHitbox looks for -- without being an enemy: nothing registers it with the manager, so lock-on, the
 * HUD and the enemy count never see it. Not `blocksSwings`: a blade that bounced off it could never break it.
 */
export default class SoulsBreakableNode extends Node {
  /** The template spawned in its place, one physics body per piece. See SoulsDebris. */
  @attribute
  public debrisTemplate: TemplateName = 'Barrel Debris'
  /** Metres per second the pieces leave at, along the blow. */
  @attribute
  public breakSpeed: number = 3.5
  /** A roll breaks it only this fast or faster (metres per second). */
  @attribute
  public rollBreakSpeed: number = 2
  @attribute
  public breakSound: SoundName = 'Break'
  @attribute
  public team: string = 'enemy'
  @attribute
  public isBreakable: boolean = true
  @attribute
  public isBroken: boolean = false
  @attribute
  public hurtboxActive: boolean = true

  private _inside: Node[] = []

  /** SoulsHitbox's damage hook: any hit breaks it, pushed away from whoever struck. */
  public receiveHit(_damage: number, _poise: number, from: Node, _point?: ArrayLike<number>): boolean {
    if (this.isBroken) return false
    const me = this.worldPosition
    const at = from ? from.worldPosition : me
    this.shatter([me[0] - at[0], 0.6, me[2] - at[2]])
    return true
  }

  onStart() {
    // The roll zone is a Trigger of its own under the barrel (the Hurtbox is SoulsHitbox's): hear it here.
    for (const zone of this.children) {
      if (zone.nodeType !== 'trigger' || zone.name === 'Hurtbox') continue
      zone.onTriggerEnter = (other: Node) => this.onTriggerEnter(other)
      zone.onTriggerExit = (other: Node) => this.onTriggerExit(other)
    }
  }

  onTriggerEnter(other: Node) {
    // What came in is a body: a character's is its Collider, and the character is what rolls.
    const who = other?.character ?? other
    if (who && !this._inside.includes(who)) this._inside.push(who)
  }

  onTriggerExit(other: Node) {
    const who = other?.character ?? other
    this._inside = this._inside.filter(n => n !== who)
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
