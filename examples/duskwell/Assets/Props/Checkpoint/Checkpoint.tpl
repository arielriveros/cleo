{
  "id": "5324ec14c5e2e6c9cd89a28a9657dbb1",
  "name": "Checkpoint",
  "nodeJson": {
    "id": "22a661c363b42d1013e9c4812ffdab46",
    "name": "Checkpoint",
    "type": "trigger",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "d99b6371e4f31de258530897c132e9f0",
        "name": "Lamp",
        "type": "animatedSprite",
        "position": [0, -1.5, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "sprite": {
          "constraints": "free",
          "tilesetId": "7aab2b4eb719012bc6464a7b0f6a27ea",
          "tileset": {
            "id": "7aab2b4eb719012bc6464a7b0f6a27ea",
            "textureId": "lamp.png",
            "imageWidth": 64,
            "imageHeight": 48,
            "tileWidth": 16,
            "tileHeight": 48,
            "margin": 0,
            "spacing": 0,
            "columns": 4,
            "rows": 1,
            "overdrive": 2,
            "pixelsPerUnit": 16,
            "tiles": {},
            "terrains": [],
            "variantSets": []
          },
          "tileIndex": 0,
          "tint": [1, 1, 1],
          "opacity": 1,
          "transparent": true,
          "side": "double",
          "wireframe": false,
          "pivot": [0.5, 0]
        },
        "animation": {
          "frames": [0, 1, 2, 3],
          "frameSource": "node",
          "fps": 8,
          "loop": true
        }
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "6e91a6f6260a20c04634ef9ed8af84f9",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "sensor": {
      "shapes": [],
      "size": [1.2, 3],
      "offset": [0, 0],
      "layer": 256,
      "mask": 16,
      "detectTriggers": false,
      "continuous": false,
      "enabled": true
    },
    "script": "import { AnimatedSpriteNode, Logger, Node, SaveGame, TriggerNode } from 'cleo'\nimport type { Color } from 'cleo'\nimport { save, child, attribute } from 'cleo/decorators'\n\n/**\n * Duskwell -- a checkpoint: a lamp the player lights by walking past it. Attach to an Area 2D that sees the\n * player's layer; its `Lamp` child is the sprite, dim until lit. Lighting it heals the player and makes it\n * where the player comes back after a death.\n *\n * Every lamp the player reaches saves the game to the `auto` slot (SaveGame): the diamonds and moves the\n * player carries, the lamps lit, the pickups taken. The title screen's Continue loads it.\n */\nexport default class DuskCheckpoint extends TriggerNode {\n  @attribute\n  public litTint: Color = [1, 1, 1]\n  @attribute\n  public unlitTint: Color = [0.35, 0.35, 0.45]\n  @attribute\n  public healTo: number = 99\n\n  /** Whether the lamp is lit: a loaded game keeps it lit. */\n\n  @save\n  private _lit: boolean = false\n  @child('Lamp')\n  private _lamp: AnimatedSpriteNode = null\n\n  onStart() {\n    // A lamp lit before a save comes back lit (the field is @save).\n    if (this._lamp) this._lamp.tint = (this._lit ? this.litTint : this.unlitTint) as [number, number, number]\n  }\n\n  onTriggerEnter(other: Node) {\n    const p = other as any\n    if (typeof p.setRespawn !== 'function') return\n    const here = this.worldPosition\n    p.setRespawn(here[0], here[1] - this.size[1] / 2 + 0.01)\n    p.heal?.(this.healTo)\n    if (!this._lit) {\n      this._lit = true\n      if (this._lamp) this._lamp.tint = this.litTint as [number, number, number]\n      p.say?.('Checkpoint')\n    }\n    this._save()\n  }\n\n  /** The checkpoint save. Only where the game can save (it cannot in a test with no store, say). */\n  private _save() {\n    if (!SaveGame.available) return\n    SaveGame.save('auto', { label: this.name })\n      .catch(e => Logger.warn(`The checkpoint could not save: ${e?.message ?? e}`, 'Script'))\n  }\n}\n",
    "scriptVars": {}
  },
  "scripts": {},
  "textureIds": []
}
