import { Logger, Node } from 'cleo'

/**
 * Hollow Keep — where an enemy lives. The script of the "Enemy Spawn" template: place a copy of it (and
 * rotate it) where the enemy should stand, and it instantiates `templateName` there.
 *
 * `spawnables` is the list of templates a spawn may make, edited once in the template; each placed copy
 * picks one of them for `templateName` from a dropdown in the inspector (its `@options` tag).
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
  /** The templates a spawn may create. Edit the list in the Enemy Spawn template. */
  public spawnables: string[] = ['Hollow', 'Hollow Sorcerer', 'Elite Knight', 'Hollow Warden']
  /**
   * Which of `spawnables` this spawn creates.
   * @options spawnables
   */
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
    if (!(this.spawnables ?? []).includes(this.templateName))
      Logger.warn('Hollow Keep: spawn "' + this.name + '" makes "' + this.templateName + '", which is not in its spawnables.', 'Script')
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
