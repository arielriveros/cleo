import { Logger, Node } from 'cleo'

/**
 * Hollow Keep — where an enemy lives. Attach to an empty node placed (and rotated) where the enemy
 * should stand; it instantiates `templateName` there.
 *
 * Enemies are TEMPLATES spawned at runtime rather than placed nodes, because resting at a bonfire must
 * bring every one of them back fresh — a placed node would need every field it ever changed restored by
 * hand. The spawn removes its previous instance (alive or corpse) and makes a new one.
 *
 * `isBossSpawn` marks the boss: it is created at the start and after a death mid-fight, but never by
 * resting, and never again once defeated. The manager is told about it so the HUD bar and the fog gate
 * can find the live boss.
 */
export default class SoulsEnemySpawnNode extends Node {
  public templateName: string = 'Hollow'
  public isBossSpawn: boolean = false
  /** Seconds after the scene starts before the first spawn — lets the level settle first. */
  public initialDelay: number = 0.1

  private _gm: Node = null
  private _live: Node = null

  onStart() {
    this._gm = this.findNode('GameManager')
    ;(this._gm as any)?.registerSpawn?.(this)
    this.after(this.initialDelay, () => this.respawnEnemy())
  }

  /** Remove whatever this spawn made before, and make a fresh one. */
  public respawnEnemy(): void {
    if (this._live && this.scene?.getNodeById(this._live.id)) {
      try { this._live.remove() } catch { /* already gone */ }
    }
    this._live = null
    const p = this.worldPosition
    const f = this.worldForward
    const yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI
    const enemy = this.scene?.instantiate(this.templateName, { position: [p[0], p[1], p[2]], rotation: [0, yaw, 0] })
    if (!enemy) {
      Logger.warn('Hollow Keep: spawn "' + this.name + '" found no template "' + this.templateName + '".', 'Script')
      return
    }
    this._live = enemy
    if (this.isBossSpawn) (this._gm as any)?.registerBoss?.(enemy)
  }

  /** The enemy this spawn made, or null. */
  public liveEnemy(): Node { return this._live }
}
