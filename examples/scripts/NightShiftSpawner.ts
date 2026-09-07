import { Logger, Node, clamp, lerp } from 'cleo'

/**
 * Night Shift — the zombie spawner. Attach to an empty node named `ZombieSpawner` at the scene root.
 *
 * It sits on its own node deliberately. Timers are cancelled when their node despawns, so a spawner that
 * lived on a zombie would stop scheduling the moment that zombie died.
 *
 * ## The curve
 *
 *   interval = baseInterval / (1 + levelRamp * (level - 1))    harder every level
 *   interval *= lerp(nightStart, nightEnd, t)                  and harder as the night wears on
 *
 * `every()` cannot express that, because the period would be fixed at the moment it was scheduled. A
 * self-rescheduling `after()` re-reads the curve on each tick, which is the whole point.
 *
 * ## Placement
 *
 * Spawn points come from the navmesh when one is baked — `randomPoint` only ever returns somewhere
 * genuinely walkable — and fall back to authored `Spawn Point` child nodes otherwise, so the level works
 * on a scene nobody has baked yet. Either way a candidate closer to the player than `minPlayerDistance`
 * is rejected, so nothing ever materialises in your face.
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
  /** Hard cap on live zombies. Each one costs a think, a perception step and a few raycasts a frame. */
  public maxAlive: number = 14
  /** Metres. A candidate closer than this to the player is rejected. */
  public minPlayerDistance: number = 18
  /** How many placements to try before giving up for this tick. */
  public placementTries: number = 12
  /** Radius of the authored-spawn-point fallback scatter, in metres. */
  public fallbackRadius: number = 45

  private _director: Node = null
  private _player: Node = null
  private _points: Node[] = []
  private _live: Node[] = []

  onStart() {
    this._director = this.findNode('GameManager')
    this._player = this.findNode('Playable')
    this._points = this.getChildByName('Spawn Point')
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
    const at = this._pickPoint()
    if (!at) return

    const zombie = this.scene?.instantiate(this.templateName, {
      position: at,
      rotation: [0, Math.random() * 360, 0],
    })
    if (!zombie) {
      // instantiate already logged the available template names; say why we are giving up.
      Logger.warn('Night Shift: spawner found no "' + this.templateName + '" template; stopping.', 'Script')
      return
    }
    this._live.push(zombie)
  }

  /** A walkable point far enough from the player, or null if we could not find one this tick. */
  private _pickPoint(): number[] {
    const player = this._player ? this._player.worldPosition : null
    const far = (p: number[]) => !player
      || Math.hypot(p[0] - player[0], p[2] - player[2]) >= this.minPlayerDistance

    const mesh = this._navMesh()
    for (let i = 0; i < this.placementTries; i++) {
      const candidate = mesh ? this._randomOnMesh(mesh) : this._randomFallback()
      if (candidate && far(candidate)) return candidate
    }
    return null
  }

  private _navMesh(): any {
    for (const node of this.scene?.navMeshes ?? []) {
      const mesh = (node as any).mesh
      if (mesh && mesh.randomPoint) return mesh
    }
    return null
  }

  private _randomOnMesh(mesh: any): number[] {
    const out: number[] = [0, 0, 0]
    return mesh.randomPoint(out) ? [out[0], out[1], out[2]] : null
  }

  /**
   * No navmesh: scatter around an authored spawn point, else around the spawner itself. The Y is left
   * at the reference point's height and the capsule drops onto the ground, which is why `isGrounded`
   * reads false for the first fraction of a second — that is not a bug.
   */
  private _randomFallback(): number[] {
    const origin = this._points.length > 0
      ? this._points[Math.floor(Math.random() * this._points.length)].worldPosition
      : this.worldPosition
    const angle = Math.random() * Math.PI * 2
    const radius = this.fallbackRadius * Math.sqrt(Math.random())
    return [origin[0] + Math.sin(angle) * radius, origin[1], origin[2] + Math.cos(angle) * radius]
  }
}
