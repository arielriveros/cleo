{
  "id": "75f8b84e950a3a7a354569f95b170e4f",
  "name": "Diamond",
  "nodeJson": {
    "id": "d6e13a5b16c1163c3dd7c071e53426ca",
    "name": "Diamond",
    "type": "trigger",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "e6ab8c8a3122d933e01994584bef6c61",
        "name": "Gem",
        "type": "animatedSprite",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1.399999976158142, 1.399999976158142, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "sprite": {
          "constraints": "free",
          "tilesetId": "b2a3da3627db44801d729ee2599a91cd",
          "tileset": {
            "id": "b2a3da3627db44801d729ee2599a91cd",
            "textureId": "diamond.png",
            "imageWidth": 40,
            "imageHeight": 9,
            "tileWidth": 8,
            "tileHeight": 9,
            "margin": 0,
            "spacing": 0,
            "columns": 5,
            "rows": 1,
            "overdrive": 1.6,
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
          "wireframe": false
        },
        "animation": {
          "frames": [0, 1, 2, 3, 4],
          "frameSource": "node",
          "fps": 10,
          "loop": true,
          "randomStart": true
        }
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "1aed05f92f0cc5b980c5abf1be50ee9a",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "sensor": {
      "shapes": [],
      "size": [0.9, 0.9],
      "offset": [0, 0],
      "layer": 256,
      "mask": 16,
      "detectTriggers": false,
      "continuous": false,
      "enabled": true
    },
    "script": "import { Node, TriggerNode } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * Duskwell -- something lying in the world for the player to take. Attach to an Area 2D that sees the\n * player's layer; its children are the visuals (a sprite), which bob.\n *\n *   kind = 'diamond'     +`amount` diamonds\n *   kind = 'heart'       heals `amount`\n *   kind = 'dash' | 'doubleJump' | 'wallJump'   a movement ability, for good\n *\n * The player decides what a kind does (DuskPlayer.collect); this only hands it over and goes.\n */\nexport default class DuskPickup extends TriggerNode {\n  @attribute\n  public kind: string = 'diamond'\n  @attribute\n  public amount: number = 1\n  @attribute\n  public bobHeight: number = 0.12\n  @attribute\n  public bobSpeed: number = 3\n\n  private _time: number = 0\n  private _taken: boolean = false\n  private _base: number[] = []\n\n  onStart() {\n    this._time = (this.worldPosition[0] * 0.37) % 6.28\n    this._base = this.children.map(c => c.position[1])\n  }\n\n  onUpdate(delta: number) {\n    this._time += delta * this.bobSpeed\n    const y = Math.sin(this._time) * this.bobHeight\n    this.children.forEach((c, i) => {\n      if (this._base[i] === undefined) return\n      const p = c.position\n      c.setPosition([p[0], this._base[i] + y, p[2]])\n    })\n  }\n\n  onTriggerEnter(other: Node) {\n    if (this._taken || typeof (other as any).collect !== 'function') return\n    this._taken = true\n    ;(other as any).collect(this.kind, this.amount)\n    this.enabled = false\n    this.remove()\n  }\n}\n",
    "scriptVars": {
      "kind": "diamond",
      "amount": 1
    }
  },
  "scripts": {},
  "textureIds": []
}
