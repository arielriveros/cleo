import { CharacterNode, Node } from 'cleo'

/**
 * Night Shift — a timed powerup. Same shape as `NightShiftPickup`: attach to the visual root for the bob
 * and spin, and to its `Trigger` child for the pickup itself.
 *
 * Three kinds, chosen by the `kind` field so one script and one template serve all of them:
 *
 *   speed        walk and run speed multiplied for a few seconds
 *   invincible   the zombie's damage check already reads `player.invincible`, so nothing else changes
 *   aoe          every zombie inside `radius` is ignited
 *
 * ## The AoE reuses the dawn burn
 *
 * It sets exactly the flag sunrise sets, so instakill and sunrise run one code path. The blast is
 * already tuned because dawn is tuned, and a zombie caught by both cannot die twice.
 *
 * ## Where the restore timer lives
 *
 * NOT here. `despawn()` and `remove()` cancel the node's own timers BEFORE `onDespawn` fires, so a
 * "give the speed back in 8 seconds" timer scheduled on the pickup that just removed itself would never
 * run, and the player would keep the buff for the rest of the level. The countdown lives on the player
 * instead, ticked in its own `onUpdate` — which also gives the HUD something to draw.
 */
export default class NightShiftPowerupNode extends Node {
  /** `speed`, `invincible` or `aoe`. */
  public kind: string = 'speed'
  /** Metres. Only used by `aoe`. */
  public radius: number = 14
  /** Trauma added to the camera rig on an AoE blast, 0..1. */
  public blastShake: number = 0.8
  public spinSpeed: number = 70
  public bobHeight: number = 0.18
  public bobSpeed: number = 1.1

  private _taken: boolean = false
  private _isTrigger: boolean = false
  private _baseY: number = 0
  private _phase: number = 0

  onStart() {
    this._isTrigger = this.trigger !== null
    this._baseY = this.position[1]
    this._phase = Math.random() * Math.PI * 2
  }

  onUpdate(delta: number, time: number) {
    if (this._isTrigger || this._taken) return
    this.rotateY(this.spinSpeed * delta)
    this.setY(this._baseY + Math.sin(time * this.bobSpeed * Math.PI * 2 + this._phase) * this.bobHeight)
  }

  onTrigger(other: Node) {
    if (this._taken || !other || !other.getVariable('isPlayer')) return
    this._taken = true
    this.collect(other)
  }

  /** Split out so a test can drive it without a physics world. */
  public collect(player: Node): void {
    const target = player as any
    if (this.kind === 'invincible') target.grantInvincibility?.()
    else if (this.kind === 'aoe') { target.flashAoe?.(); this._blast(player) }
    else target.grantSpeed?.()

    const root = this._isTrigger && this.parent ? this.parent : this
    root.remove()
  }

  /**
   * Ignite every zombie in range.
   *
   * `scene.characters` holds only SPAWNED characters, so a despawned or pooled zombie is not in it. The
   * player is in it too and is skipped by the same `isPlayer` marker the zombie brains filter on.
   */
  private _blast(player: Node): void {
    const origin = player.worldPosition
    for (const character of this.scene?.characters ?? []) {
      if (character.getVariable('isPlayer')) continue
      const zombie = character as any
      if (!zombie.ignite) continue
      const p = character.worldPosition
      if (Math.hypot(p[0] - origin[0], p[2] - origin[2]) > this.radius) continue
      zombie.ignite()
    }

    for (const rig of this.scene?.cameraRigs ?? []) rig.shake(this.blastShake)
  }
}
