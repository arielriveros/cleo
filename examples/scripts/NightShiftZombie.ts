import { CharacterNode, Logger, ModelNode, Node, clamp, lerp } from 'cleo'

/**
 * Night Shift — a zombie. Attach to the `Zombie` root of the Zombie template, which is a Character node.
 *
 * Movement, chasing and attacking-position are the behaviour machine's job on the sibling Controller;
 * this script owns only what a machine cannot express: dealing damage, catching fire, and dying.
 *
 * ## Attacking
 *
 * The brain holding `Attack` and the cooldown decide WHEN to swing; the swing itself decides when it
 * connects. `onUpdate` only fires the `Attacked` trigger, and a `hit` marker authored on the attack clip
 * calls `_land()` at the contact frame. The range is re-checked there rather than trusted from the state
 * transition, so backing away mid-swing genuinely avoids it.
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
 * ## Dying starts when the fire does
 *
 * Burning is the only way a zombie dies, so `ignite()` IS the death: it fires the `Died` trigger straight
 * away and the body collapses while it burns. It used to shamble around on fire for `burnSeconds` and
 * only then fall over, which read as a zombie that had not noticed.
 *
 * `burnSeconds` therefore means how long the body burns, not how long until it dies. The two run
 * concurrently — a 3.33 s collapse inside a 3.5 s fire — and the ragdoll takes over when the clip ends.
 * Both halves of that handover earn their place: the authored collapse is what reads as a zombie going
 * down, and the ragdoll is what settles the corpse onto whatever it landed on rather than intersecting a
 * slope in a fixed pose. The clip carries root motion (about 1.4 m of forward fall) so the collider
 * travels with the body.
 */
export default class NightShiftZombieNode extends CharacterNode {
  /** Damage per successful hit. */
  public damage: number = 12
  /**
   * Seconds between hits while in range.
   *
   * Must stay ABOVE the swing's played length (~1.8 s: the `Attack` state cuts the clip at `exitTime`
   * 0.58 and plays it at 1.5x). A trigger raised while the machine is already in `Attack` is never
   * consumed — the transition scan skips edges whose target is the current state — so it would stay
   * latched and re-fire the instant the swing ended, giving a zombie that attacks forever.
   */
  public attackCooldown: number = 2
  /** Metres. Re-checked when the hit lands, not when the state was entered. */
  public attackRange: number = 2
  /** Seconds the body burns. The zombie is already dying throughout — see `ignite`. */
  public burnSeconds: number = 3.5
  /** Seconds the ragdoll is left lying before the node is removed. */
  public corpseSeconds: number = 6
  /**
   * How long the collapse takes before the ragdoll takes over. The authored clip is 3.33 s.
   *
   * A constant, deliberately: the animator cannot be asked. `setTrigger` only sets a parameter and the
   * machine transitions on the NEXT frame, so `animator.duration` read here reports the gait field, not
   * the death clip. Keep this at or just above the clip's length.
   */
  public deathClipSeconds: number = 3.4
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
  /** Unsubscribe for the animation-event listener. `onAnimationEvent` has no auto-cleanup, unlike `after`. */
  private _offHit: (() => void) | null = null

  onStart() {
    this._player = this.findNode('Playable')
    this._brain = this.getChildByName('Brain')[0]
    // The zombie's own character, not the player's mannequin — see the Zombie template.
    this._model = this.getChildByName('Ch10')[0] as ModelNode
    this._flame = this.getChildByName('Flame')[0]
    this._fireLight = this.getChildByName('Fire Light')[0]

    // Authored hidden by the generator; hidden again here so a hand-placed zombie behaves the same.
    if (this._flame) this._flame.visible = false
    if (this._fireLight) this._fireLight.visible = false

    // The swing lands its damage from a marker ON THE ATTACK CLIP, not from a timer started beside it.
    // The marker is authored in `zombieStateMachine()` at 1.25 s into `Zombie Attack`, mid-strike; move
    // the clip or re-import a longer one and the hit follows it instead of drifting out of sync.
    const animator = this._model?.animator as any
    if (animator?.onAnimationEvent) {
      this._offHit = animator.onAnimationEvent((eventName: string) => {
        if (eventName === 'hit') this._land()
      })
    }
  }

  onDespawn() {
    // No auto-cleanup for this one. A pooled zombie that respawned without unsubscribing would hold two
    // listeners and hit twice, then three times.
    this._offHit?.()
    this._offHit = null
  }

  /**
   * The swing connecting. Everything is re-checked here rather than at wind-up: nearly a second passes
   * between committing to the attack and the arm arriving, and the player has usually moved.
   */
  private _land(): void {
    if (this._dying || this.burning) return
    const player = this._player as any
    if (!player || !player.damage) return
    if (this._planarDistanceTo(this._player) > this.attackRange) return
    player.damage(this.damage)
  }

  onUpdate(delta: number, time: number) {
    // ABOVE the dying guard, and that ordering is the whole trick: a zombie starts dying the moment it
    // catches fire, so a `_dying` early-return placed first would stop the emissive ramp and the light
    // flicker on the very frame they should begin — a zombie that dies without ever visibly burning.
    if (this.burning) this._burn(delta)
    if (this._dying) return

    this._cooldown = Math.max(0, this._cooldown - delta)
    const brain = this._brain as any
    if (!brain) return

    // Slow while drifting, sharp while hunting. See the note on `wanderTurnSpeed`.
    const hunting = brain.behaviorState !== 'Idle'
    this.turnSpeed = hunting ? this.chaseTurnSpeed : this.wanderTurnSpeed

    // ...and the same distinction for SPEED, which the AI cannot express on its own. A behaviour state's
    // `speedScale` is clamped to 0..1, so it can only throttle DOWN from `walkSpeed`; nothing anywhere on
    // the AI path sets `sprint`, which is the only thing that reaches `runSpeed`. Without this line a
    // chasing zombie can never move faster than its own shamble, and `runSpeed` is dead data.
    //
    // Patched from the script deliberately: `CharacterNode.update` runs `onUpdate` BEFORE `_stepLocomotion`
    // precisely so a script can amend the intent the controller already wrote this frame.
    this.drive().sprint = hunting

    if (brain.behaviorState !== 'Attack') return
    if (this._cooldown > 0) return

    const player = this._player as any
    if (!player || !player.damage) return
    if (this._planarDistanceTo(this._player) > this.attackRange) return

    // Commit to the swing; the cooldown is what keeps it to one per attack. The DAMAGE is not scheduled
    // here — the clip's `hit` marker calls `_land()` when the arm actually arrives (see onStart).
    this._cooldown = this.attackCooldown
    const animator = this._model?.animator as any
    // Guarded like `_die()`: a zombie with no model (the runtime test fixture) must not crash.
    if (animator?.setTrigger) animator.setTrigger('Attacked')
  }

  /** Ignite. Idempotent — the AoE blast and dawn can both name the same zombie in one frame. */
  public ignite(): void {
    if (this.burning || this._dying) return
    this.burning = true
    this._burnedFor = 0
    if (this._flame) this._flame.visible = true
    if (this._fireLight) this._fireLight.visible = true
    // Catching fire IS dying here — there is no other way a zombie goes down — so the collapse starts on
    // this frame rather than `burnSeconds` later. `_burn` keeps running above the dying guard in
    // `onUpdate`, so the body burns as it falls.
    this._die()
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

    // The fire burns out. The zombie has been dead since ignition; this is only the end of the effect,
    // so the flame is hidden here rather than in `_die()`, which now runs on the first frame.
    if (t >= 1) {
      this.burning = false
      if (this._flame) this._flame.visible = false
      if (this._fireLight) this._fireLight.visible = false
    }
  }

  private _die(): void {
    if (this._dying) return
    this._dying = true

    // Stop steering a corpse. Releasing the pawn also stops the controller thinking about it.
    const brain = this._brain as any
    if (brain && brain.release) brain.release()
    this.velocity = [0, 0, 0]

    // The flame is NOT hidden here any more: this runs the moment the zombie catches fire, so putting it
    // out would extinguish the fire on the frame it started. `_burn` hides it when it burns out.

    const animator = this._model?.animator as any
    if (animator?.setTrigger) {
      animator.setTrigger('Died')
      // `deathClipSeconds`, NOT `animator.duration`. `setTrigger` only writes a parameter — the machine
      // transitions on the next frame — so `duration` here still reports whatever is playing, which is
      // the gait FIELD, whose weighted duration is dominated by the 6.1 s idle. That read was longer than
      // `corpseSeconds`, so `remove()` fired first and cancelled this timer: the ragdoll never started at
      // all in the shipped game, and the zombie simply vanished holding its last pose.
      this.after(this.deathClipSeconds, () => this._collapse())
    } else {
      this._collapse()
    }
  }

  /**
   * Hand the skeleton to physics, once the death clip has played it into a heap.
   *
   * Deliberately AFTER the clip rather than instead of it: starting the ragdoll upright makes the body
   * fold from a standing pose every time, which reads as a dropped puppet rather than a death.
   */
  private _collapse(): void {
    const physics = this.scene?.physics as any
    if (physics && physics.startRagdoll && this._model) {
      try { physics.startRagdoll(this._model) }
      catch (e) { Logger.warn('Night Shift: ragdoll failed, falling back to a still corpse: ' + e, 'Script') }
    }

    // Scheduled HERE rather than at death, so `corpseSeconds` measures how long the corpse lies there
    // instead of quietly starting while the body is still falling. Scheduled on the node being removed,
    // which is fine — removal is what the timer DOES. A restore timer would have to live elsewhere; see
    // NightShiftPowerup.
    this.after(this.corpseSeconds, () => this.remove())
  }

  private _planarDistanceTo(other: Node): number {
    if (!other) return Infinity
    const a = this.worldPosition
    const b = other.worldPosition
    return Math.hypot(b[0] - a[0], b[2] - a[2])
  }
}
