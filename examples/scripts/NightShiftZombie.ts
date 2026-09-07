import { CharacterNode, Logger, ModelNode, Node, clamp, lerp } from 'cleo'

/**
 * Night Shift — a zombie. Attach to the `Zombie` root of the Zombie template, which is a Character node.
 *
 * Movement, chasing and attacking-position are the behaviour machine's job on the sibling Controller;
 * this script owns only what a machine cannot express: dealing damage, catching fire, and dying.
 *
 * ## Attacking without an attack clip
 *
 * There is no attack animation in this project, so damage runs on a cooldown while the brain holds its
 * `Attack` state, and the pose stays Idle. The range is re-checked at the moment of the hit rather than
 * trusted from the state transition, so backing away mid-swing genuinely avoids it.
 *
 * ## Burning
 *
 * The engine has no particle system, so fire is three cheap layers: an emissive ramp on the material, a
 * billboarded flame sprite, and a flickering point light. All three are already in this project.
 *
 * The emissive ramp is safe per zombie because `Scene.instantiate` makes a COMPLETE copy — children,
 * materials, colliders and scripts, with fresh ids — so nothing is shared with the template or with the
 * other instances. Every submesh material is walked, not just `materials[0]`, or a multi-material
 * zombie would burn in patches.
 *
 * ## Dying without a death clip
 *
 * There is no death animation either, so death is a RAGDOLL — the mannequin already carries a full
 * ragdoll configuration. `startRagdoll` puts the animator into ragdoll mode and hands the skeleton to
 * physics, which is a better corpse than any single clip anyway.
 */
export default class NightShiftZombieNode extends CharacterNode {
  /** Damage per successful hit. */
  public damage: number = 12
  /** Seconds between hits while in range. */
  public attackCooldown: number = 1.2
  /** Metres. Re-checked when the hit lands, not when the state was entered. */
  public attackRange: number = 2
  /** Seconds from ignition to death. */
  public burnSeconds: number = 3.5
  /** Seconds the ragdoll is left lying before the node is removed. */
  public corpseSeconds: number = 6
  /** Set by the director at dawn, and by the AoE powerup. The behaviour machine reads it as a builtin. */
  public burning: boolean = false
  /**
   * Degrees per second the body turns while WANDERING, and while doing anything else.
   *
   * They have to differ, because wander and "face where you are going" form a feedback loop. `wander`
   * aims at a point offset from the agent's CURRENT forward; the character then turns to face that, which
   * moves forward, which moves the point. The faster it turns, the tighter it closes the loop — at 220
   * deg/s a zombie covers 0.9 m in thirty seconds and reads as spinning on the spot. At 30 it covers 12
   * and reads as a shamble.
   *
   * Chasing has no such loop: the target is a place in the world, not an offset from the agent, so it can
   * turn as sharply as it likes.
   */
  public wanderTurnSpeed: number = 30
  public chaseTurnSpeed: number = 140

  private _cooldown: number = 0
  private _burnedFor: number = 0
  private _dying: boolean = false
  private _player: Node = null
  private _brain: Node = null
  private _model: ModelNode = null
  private _flame: Node = null
  private _fireLight: Node = null

  onStart() {
    this._player = this.findNode('Playable')
    this._brain = this.getChildByName('Brain')[0]
    this._model = this.getChildByName('Ch36')[0] as ModelNode
    this._flame = this.getChildByName('Flame')[0]
    this._fireLight = this.getChildByName('Fire Light')[0]

    // Authored visible so they are easy to find in the editor; hidden until the zombie actually burns.
    if (this._flame) this._flame.visible = false
    if (this._fireLight) this._fireLight.visible = false
  }

  onUpdate(delta: number, time: number) {
    if (this._dying) return
    if (this.burning) { this._burn(delta); return }

    this._cooldown = Math.max(0, this._cooldown - delta)
    const brain = this._brain as any
    if (!brain) return

    // Slow while drifting, sharp while hunting. See the note on `wanderTurnSpeed`.
    this.turnSpeed = brain.behaviorState === 'Idle' ? this.wanderTurnSpeed : this.chaseTurnSpeed

    if (brain.behaviorState !== 'Attack') return
    if (this._cooldown > 0) return

    const player = this._player as any
    if (!player || !player.damage) return
    if (this._planarDistanceTo(this._player) > this.attackRange) return

    this._cooldown = this.attackCooldown
    player.damage(this.damage)
  }

  /** Ignite. Idempotent — the AoE blast and dawn can both name the same zombie in one frame. */
  public ignite(): void {
    if (this.burning || this._dying) return
    this.burning = true
    this._burnedFor = 0
    if (this._flame) this._flame.visible = true
    if (this._fireLight) this._fireLight.visible = true
  }

  private _burn(delta: number): void {
    this._burnedFor += delta
    const t = clamp(this._burnedFor / Math.max(0.001, this.burnSeconds), 0, 1)

    // Well above 1, or it clamps to white instead of blooming.
    const glow = lerp(0.5, 7, t)
    const materials = this._model?.model?.materials
    if (materials) {
      for (const material of materials) {
        // The key differs by shading model, and writing the wrong one is silently ignored.
        if (material.properties.has('emissiveFactor')) {
          material.properties.set('emissiveFactor', [1, lerp(0.5, 0.18, t), 0.05])
          material.properties.set('emissiveIntensity', glow)
        } else {
          material.properties.set('emissive', [glow, glow * lerp(0.5, 0.18, t), glow * 0.05])
        }
      }
    }

    const light = (this._fireLight as any)?.light
    // A cheap flicker: two out-of-phase sines beat a random, which reads as noise rather than fire.
    if (light) light.intensity = lerp(400, 90, t) * (0.75 + 0.25 * Math.sin(this._burnedFor * 21)
      + 0.12 * Math.sin(this._burnedFor * 37))

    if (t >= 1) this._die()
  }

  private _die(): void {
    if (this._dying) return
    this._dying = true

    // Stop steering a corpse. Releasing the pawn also stops the controller thinking about it.
    const brain = this._brain as any
    if (brain && brain.release) brain.release()
    this.velocity = [0, 0, 0]

    const physics = this.scene?.physics as any
    if (physics && physics.startRagdoll && this._model) {
      try { physics.startRagdoll(this._model) }
      catch (e) { Logger.warn('Night Shift: ragdoll failed, falling back to a still corpse: ' + e, 'Script') }
    }

    if (this._flame) this._flame.visible = false
    if (this._fireLight) this._fireLight.visible = false

    // Scheduled on this node, which is the thing being removed — that is fine, because `remove()` is
    // what the timer DOES. A restore timer would have to live elsewhere; see NightShiftPowerup.
    this.after(this.corpseSeconds, () => this.remove())
  }

  private _planarDistanceTo(other: Node): number {
    if (!other) return Infinity
    const a = this.worldPosition
    const b = other.worldPosition
    return Math.hypot(b[0] - a[0], b[2] - a[2])
  }
}
