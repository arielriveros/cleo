{
  "id": "cfae2f5d46f7a4739399a574e5715b04",
  "name": "Blood Spray",
  "nodeJson": {
    "id": "ddc1d3e05b090d3c6e6de71a3bf791d1",
    "name": "Blood Spray",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "07d554f0e0eb34903e3a06614801687e",
        "name": "Splatter",
        "type": "animatedSprite",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [0.8, 0.8, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "sprite": {
          "constraints": "spherical",
          "tilesetId": "5aa1a572007663be541f5cb9b618d229",
          "tileset": {
            "id": "5aa1a572007663be541f5cb9b618d229",
            "name": "Blood Burst",
            "textureId": "f3fda599f5b1231ef5d709465395de10",
            "imageWidth": 512,
            "imageHeight": 512,
            "tileWidth": 128,
            "tileHeight": 128,
            "margin": 0,
            "spacing": 0,
            "columns": 4,
            "rows": 4,
            "overdrive": 1,
            "tiles": {},
            "terrains": [],
            "variantSets": [],
            "textureIds": [
              "f3fda599f5b1231ef5d709465395de10",
              "5d196ca514dc18ee546aab9e76d5daf2",
              "244400caca8cfd0b8b660894f4b953bc"
            ],
            "normalTextureId": "5d196ca514dc18ee546aab9e76d5daf2",
            "ormTextureId": "244400caca8cfd0b8b660894f4b953bc"
          },
          "tileIndex": 0,
          "tint": [1, 1, 1],
          "opacity": 1,
          "transparent": true,
          "side": "double",
          "wireframe": false,
          "lit": true,
          "softness": 0.05
        },
        "animation": {
          "frames": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          "frameSource": "node",
          "fps": 30,
          "loop": false
        }
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "d9a7c3b075f9d7aa51316d4a0e1075f5",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * Hollow Keep — a fire-and-forget effect. Attach to the root of an effect template (hit spark, bolt\n * impact, slam dust). On start it bursts every Particle System child, fades every point light child over\n * `lifetime`, and removes itself when that time is up.\n *\n * Swap the look by editing the template's particle systems; this script only owns the lifetime.\n */\nexport default class SoulsFxNode extends Node {\n  @attribute\n  public lifetime: number = 1.2\n  /** Particles per child system on start. 0 leaves them to their own spawn rate / bursts. */\n  @attribute\n  public burstCount: number = 0\n\n  private _age: number = 0\n  private _lights: any[] = []\n  private _intensities: number[] = []\n\n  onStart() {\n    this._age = 0\n    const walk = (node: Node) => {\n      for (const child of node.children) {\n        const c = child as any\n        if (child.nodeType === 'particleSystem') {\n          // play(), not restart(): a fresh instance is already playing if its system plays on start,\n          // and a restart would clear and prewarm it a second time on its first frame.\n          c.play?.()\n          if (this.burstCount > 0) c.burst?.(this.burstCount)\n        }\n        if (child.nodeType === 'light' && c.light) {\n          this._lights.push(c.light)\n          this._intensities.push(c.light.intensity)\n        }\n        walk(child)\n      }\n    }\n    walk(this)\n  }\n\n  onUpdate(delta: number) {\n    this._age += delta\n    const k = Math.max(0, 1 - this._age / Math.max(0.01, this.lifetime))\n    for (let i = 0; i < this._lights.length; i++) this._lights[i].intensity = this._intensities[i] * k\n    if (this._age >= this.lifetime) this.remove()\n  }\n}\n",
    "scriptVars": {
      "lifetime": 0.58
    }
  },
  "textureIds": [
    "f3fda599f5b1231ef5d709465395de10",
    "5d196ca514dc18ee546aab9e76d5daf2",
    "244400caca8cfd0b8b660894f4b953bc"
  ],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
