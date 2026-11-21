{
  "id": "38f5b436d97241d3df28f9abde7841b5",
  "name": "FPS Bullet Hole",
  "nodeJson": {
    "id": "0b9cdff0a3b77fb1487804bc6bb560b6",
    "name": "FPS Bullet Hole",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "f792eadad329214cca6832c01e1a834a",
        "name": "Hole",
        "type": "decal",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "2ea4f6375047ee52afac018cb3e3bd66",
            "access": "public"
          }
        },
        "spawnOnStart": true,
        "decal": {
          "size": [0.16, 0.5, 0.16],
          "opacity": 1,
          "sortOrder": 0,
          "angleFade": 0.3,
          "depthFade": 0.3,
          "affects": {
            "albedo": true,
            "normal": false,
            "surface": true,
            "emissive": false
          },
          "receivers": "all",
          "pattern": "material",
          "material": {
            "type": "pbr",
            "baseColor": [1, 1, 1],
            "metallic": 0,
            "roughness": 0.9,
            "reflectance": 0.5,
            "opacity": 1,
            "emissiveFactor": [0, 0, 0],
            "emissiveIntensity": 1,
            "textures": {
              "baseColorTexture": "6cd819fe150c7fc529e1944eb69edaba"
            },
            "config": {
              "side": "front",
              "wireframe": false,
              "transparent": false,
              "castShadow": false,
              "probeable": true
            }
          }
        }
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "418a54337130c32b9f51d53a9f3d07f6",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport { clamp } from '@/FPS/Scripts/FpsShared'\n\n/**\n * FPS example — a bullet hole. Attach to the root of a template whose children are Decal nodes; the shooter\n * (FpsCombatant) instantiates one at the hit, turned so its decals project straight into the surface. On\n * start each decal takes a random spin about its own axis and a random size; after `lifetime` they fade over\n * `fadeSeconds` and the template removes itself. The Game Manager also removes the oldest past its limit.\n */\nexport default class FpsDecalNode extends Node {\n  @attribute\n  public lifetime: number = 45\n  @attribute\n  public fadeSeconds: number = 6\n  @attribute\n  public minSize: number = 0.8\n  @attribute\n  public maxSize: number = 1.2\n\n  private _age: number = 0\n  private _decals: any[] = []\n\n  onStart() {\n    this._decals = this.children.filter(c => c.nodeType === 'decal')\n    const scale = this.minSize + Math.random() * Math.max(0, this.maxSize - this.minSize)\n    for (const d of this._decals) {\n      d.setRotation([0, Math.random() * 360, 0])\n      const s = d.size\n      d.size = [s[0] * scale, s[1], s[2] * scale]\n    }\n  }\n\n  onUpdate(delta: number) {\n    this._age += delta\n    const k = clamp((this.lifetime - this._age) / Math.max(0.01, this.fadeSeconds), 0, 1)\n    for (const d of this._decals) if (Math.abs(d.opacity - k) > 0.01) d.opacity = k\n    if (this._age >= this.lifetime) this.remove({ immediate: true })\n  }\n}\n",
    "scriptVars": {}
  },
  "textureIds": [
    "6cd819fe150c7fc529e1944eb69edaba"
  ],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
