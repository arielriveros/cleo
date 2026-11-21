{
  "id": "f7d766fb4aa6a2d45fe358ba67a5b546",
  "name": "Enemy Spawn",
  "nodeJson": {
    "id": "d83f05f50e5bba770a28376148dbd849",
    "name": "Enemy Spawn",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "a078de267719d678491145c245b8cf38",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Logger, Node } from 'cleo'\nimport { options, find, attribute } from 'cleo/decorators'\nimport type { TemplateName } from 'cleo'\n\n/**\n * Hollow Keep — where an enemy lives. The script of the \"Enemy Spawn\" template: place a copy of it (and\n * rotate it) where the enemy should stand, and it instantiates `templateName` there.\n *\n * `spawnables` is the list of templates a spawn may make, edited once in the template; each placed copy\n * picks one of them for `templateName` from a dropdown in the inspector (its `@options` decorator).\n *\n * Enemies are TEMPLATES spawned at runtime rather than placed nodes, because resting at a bonfire must\n * bring every one of them back fresh — a placed node would need every field it ever changed restored by\n * hand. The spawn removes its previous instance (alive or corpse) and makes a new one.\n *\n * `isBossSpawn` marks the boss: it is created at the start and after a death mid-fight, but never by\n * resting, and never again once defeated. The manager is told about it so the HUD bar and the fog gate\n * can find the live boss.\n */\nexport default class SoulsEnemySpawnNode extends Node {\n  /** The templates a spawn may create. Edit the list in the Enemy Spawn template. */\n  @attribute\n  public spawnables: TemplateName[] = ['Hollow', 'Hollow Sorcerer', 'Elite Knight', 'Hollow Warden']\n  /** Which of `spawnables` this spawn creates. */\n  @options('spawnables')\n  @attribute\n  public templateName: string = 'Hollow'\n  @attribute\n  public isBossSpawn: boolean = false\n  /**\n   * A patrol route on the scene's Nav Mesh, by name: the enemy walks it, looping, until it sees someone,\n   * and goes back to it after giving up a chase. Empty: it stands where it spawned.\n   */\n  @attribute\n  public patrolRoute: string = ''\n  /** Seconds after the scene starts before the first spawn — lets the level settle first. */\n  @attribute\n  public initialDelay: number = 0.1\n\n  @find('GameManager')\n  private _gm: Node = null\n  private _live: Node = null\n\n  onStart() {\n    ;(this._gm as any)?.registerSpawn?.(this)\n    this.after(this.initialDelay, () => this.respawnEnemy())\n  }\n\n  /** Remove whatever this spawn made before, and make a fresh one. */\n  public respawnEnemy(): void {\n    if (this._live && this.scene?.getNodeById(this._live.id)) {\n      // Its Collider, which the template placed and which carries the rest.\n      try { (this._live.collider ?? this._live).remove() } catch { /* already gone */ }\n    }\n    this._live = null\n    // A boss already defeated (in this game, or in the save it was loaded from) is never made again.\n    if (this.isBossSpawn && (this._gm as any)?.bossDefeated) return\n    if (!(this.spawnables ?? []).includes(this.templateName))\n      Logger.warn('Hollow Keep: spawn \"' + this.name + '\" makes \"' + this.templateName + '\", which is not in its spawnables.', 'Script')\n    const p = this.worldPosition\n    const f = this.worldForward\n    const yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI\n    // An enemy template's root is its Collider; the enemy is the Character in it.\n    const root = this.scene?.instantiate(this.templateName, { position: [p[0], p[1], p[2]], rotation: [0, yaw, 0] })\n    const enemy = root?.character ?? root\n    if (!enemy) {\n      Logger.warn('Hollow Keep: spawn \"' + this.name + '\" found no template \"' + this.templateName + '\".', 'Script')\n      return\n    }\n    this._live = enemy\n    if (this.patrolRoute) {\n      // The brain is the enemy's AI controller: the one child with a route to walk.\n      const brain: any = enemy.children.find((c: any) => 'routeName' in c)\n      if (brain) brain.routeName = this.patrolRoute\n      else Logger.warn('Hollow Keep: \"' + this.templateName + '\" has no AI controller to walk route \"' + this.patrolRoute + '\".', 'Script')\n    }\n    if (this.isBossSpawn) (this._gm as any)?.registerBoss?.(enemy)\n  }\n\n  /** The enemy this spawn made, or null. */\n  public liveEnemy(): Node { return this._live }\n}\n",
    "scriptVars": {
      "spawnables": [
        "Hollow",
        "Hollow Sorcerer",
        "Elite Knight",
        "Hollow Warden"
      ],
      "templateName": "Hollow"
    }
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
