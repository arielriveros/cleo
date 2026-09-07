import { Logger, Node, clamp, lerp } from 'cleo'

/**
 * Night Shift — the zombie spawner. ONE node at the scene root; there are no authored spawn points.
 *
 * It sits on its own node deliberately. Timers are cancelled when their node despawns, so a spawner
 * that lived on a zombie would stop scheduling the moment that zombie died.
 *
 * ## Where they appear
 *
 * A random point on the disc the director describes, dropped onto the terrain by a downward raycast and
 * rejected unless it landed on walkable ground — see `NightShiftDirector.groundAt`. That is what keeps
 * a zombie off the roof of the house, where it would only walk off the edge.
 *
 * A candidate closer to the player than `minPlayerDistance` is thrown away too, so nothing ever
 * materialises in your face.
 *
 * ## The curve
 *
 *   interval = baseInterval / (1 + levelRamp * (level - 1))    harder every level
 *   interval *= lerp(nightStart, nightEnd, t)                  and harder as the night wears on
 *
 * `every()` cannot express that: its period is fixed when it is scheduled. A self-rescheduling
 * `after()` re-reads the curve on each tick, which is the whole point.
 */
export default class NightShiftSpawnerNode extends Node {
  /** Template name to instantiate. */
  public templateName: string = 'Zombie'
  /** Seconds between spawns at level 1, at dusk. */
  public baseInterval: number = 6
  /** How much each level past the first compresses the interval. */
  public levelRamp: number = 0.35
  /** Interval multiplier at dusk. */
  public nightStart: number = 1.4
  /** Interval multiplier at dawn. Below 1, so the night tightens. */
  public nightEnd: number = 0.6
  /** Never spawn faster than this, whatever the level. */
  public minInterval: number = 0.8
  /** Hard cap on live zombies. Each costs a think, a perception step and a few raycasts a frame. */
  public maxAlive: number = 14
  /** Metres. A candidate closer than this to the player is rejected. */
  public minPlayerDistance: number = 18

  private _director: Node = null
  private _live: Node[] = []

  onStart() {
    this._director = this.findNode('GameManager')
    if (!this._director) {
      Logger.warn('Night Shift: the spawner found no GameManager, so it cannot place anything.', 'Script')
      return
    }
    this.after(this.intervalSeconds(), () => this._tick())
  }

  private _tick(): void {
    const director = this._director as any
    if (director && director.finished) return

    // Drop the ones that removed themselves, so `maxAlive` counts what is actually walking around.
    this._live = this._live.filter(z => z && z.scene && !z.markForRemoval)

    if (!director?.isDay && this._live.length < this.maxAlive) this._spawnOne()
    this.after(this.intervalSeconds(), () => this._tick())
  }

  /**
   * Seconds until the next spawn, re-read on every tick so the curve can move under it.
   * Public because it is the whole difficulty model and deserves a test of its own.
   */
  public intervalSeconds(): number {
    const director = this._director as any
    const level = Math.max(1, director?.level ?? 1)
    const t = clamp(director?.progress ?? 0, 0, 1)
    const base = this.baseInterval / (1 + this.levelRamp * (level - 1))
    return Math.max(this.minInterval, base * lerp(this.nightStart, this.nightEnd, t))
  }

  private _spawnOne(): void {
    const director = this._director as any
    const at = director.findGroundSpot(this.minPlayerDistance)
    // No walkable spot this tick is not an error — the next tick tries again from scratch.
    if (!at) return

    const zombie = this.scene?.instantiate(this.templateName, {
      position: at,
      rotation: [0, Math.random() * 360, 0],
    })
    if (!zombie) {
      // instantiate already logged the available template names; say why we are giving up.
      Logger.warn('Night Shift: no "' + this.templateName + '" template, so no zombies.', 'Script')
      return
    }
    this._live.push(zombie)
  }
}
