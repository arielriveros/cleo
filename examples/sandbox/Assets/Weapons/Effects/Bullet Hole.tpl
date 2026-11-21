{
  "id": "b4fb65c880f42b325f469398c61e3bc6",
  "name": "Bullet Hole",
  "nodeJson": {
    "id": "758043e6854204412109881cef09a55f",
    "name": "Bullet Hole",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "e9a25c445c44629f629ec80e7bc17db9",
        "name": "Hole",
        "type": "decal",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "295b2e5a248a48e485fc610d6c620b5a",
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
            "opacity": 1,
            "emissiveFactor": [0, 0, 0],
            "textures": {
              "baseColorTexture": "02abfa1666382b61c7233e92757bb43f"
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
        "value": "6ebf6bea06948d4fb72008b1ed3e2a16",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * A Sandbox bullet hole. Attach to the root of a template whose children are Decal nodes; SandboxGun instantiates it\n * at a hit, its +Y on the surface's normal (a decal projects down its -Y), and moves it under the body hit when that\n * body moves. On start each decal takes a random size between `minSize` and `maxSize`; after `lifetime` seconds they\n * fade out over `fadeSeconds` and the hole removes itself. The gun also removes its oldest past its own limit.\n */\nexport default class SandboxBulletHoleNode extends Node {\n    @attribute({ min: 1, max: 600, step: 1 })\n    public lifetime: number = 40\n\n    @attribute({ min: 0, max: 60, step: 0.5 })\n    public fadeSeconds: number = 5\n\n    @attribute({ min: 0.1, max: 4, step: 0.05 })\n    public minSize: number = 0.8\n\n    @attribute({ min: 0.1, max: 4, step: 0.05 })\n    public maxSize: number = 1.2\n\n    private _age: number = 0\n    private _decals: any[] = []\n\n    onStart() {\n        this._decals = this.children.filter(c => c.nodeType === 'decal')\n        const scale = this.minSize + Math.random() * Math.max(0, this.maxSize - this.minSize)\n        for (const d of this._decals) {\n            const s = d.size\n            d.size = [s[0] * scale, s[1], s[2] * scale]\n        }\n    }\n\n    onUpdate(delta: number) {\n        this._age += delta\n        const k = Math.max(0, Math.min(1, (this.lifetime - this._age) / Math.max(0.01, this.fadeSeconds)))\n        for (const d of this._decals) if (Math.abs(d.opacity - k) > 0.01) d.opacity = k\n        if (this._age >= this.lifetime) this.remove({ immediate: true })\n    }\n}\n",
    "scriptVars": {}
  },
  "scripts": {},
  "textureIds": [
    "02abfa1666382b61c7233e92757bb43f"
  ]
}
