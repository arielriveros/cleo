{
  "id": "bee888872c003292c255fbefae1fad2c",
  "name": "FPS Tracer",
  "nodeJson": {
    "id": "7e7249719d87880b27da8586c21ef4fb",
    "name": "FPS Tracer",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "9a5f06728de472daba9fbc839fc8d900",
        "name": "Streak",
        "type": "model",
        "position": [0, 0, -3],
        "rotation": [0, 0, 0],
        "scale": [0.018, 0.018, 6],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "58e1984689e40b7e66877dca24b5053a",
            "access": "public"
          }
        },
        "spawnOnStart": true,
        "model": {
          "geometry": {
            "$geo": {
              "positions": {
                "n": [-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5]
              },
              "normals": {
                "n": [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]
              },
              "tangents": {
                "n": [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]
              },
              "bitangents": {
                "n": [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]
              },
              "texCoords": {
                "n": [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]
              },
              "indices": {
                "n": [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23],
                "bits": 16
              },
              "typed": true
            }
          },
          "material": {
            "type": "pbr",
            "baseColor": [1, 0.85, 0.5],
            "metallic": 0,
            "roughness": 0.85,
            "reflectance": 0.5,
            "opacity": 1,
            "emissiveFactor": [1, 0.78, 0.4],
            "emissiveIntensity": 40,
            "emissiveExposureWeight": 1,
            "textures": {},
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
        "value": "8189ecbc5a9879aca34624a05770177a",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * FPS example — a tracer round. The shooter instantiates one at the muzzle, turned along the shot, and sets\n * `tracerLength`, the distance to what the bullet hit. It is a thin glowing streak (the template's mesh,\n * along +Z) that flies from the muzzle to the hit at `speed` and is gone: the first `trail` metres of it\n * are the streak's own length, so it never stretches past the shot.\n */\nexport default class FpsTracerNode extends Node {\n  /** Set by the shooter: distance from the muzzle to the end of the shot. */\n  @attribute\n  public tracerLength: number = 0\n  @attribute\n  public speed: number = 420\n  /** Length of the streak, metres. */\n  @attribute\n  public trail: number = 6\n\n  private _flown: number = 0\n  private _start: number[] | null = null\n  private _dir: number[] = [0, 0, 1]\n\n  onUpdate(delta: number) {\n    if (!this._start) {\n      this.updateTransforms(this.parent ? this.parent.worldTransform : null)\n      const p = this.worldPosition\n      this._start = [p[0], p[1], p[2]]\n      const f = this.worldForward\n      this._dir = [f[0], f[1], f[2]]\n      // The streak is shortened to the shot when the shot is shorter.\n      const s = Math.min(1, Math.max(0.05, this.tracerLength / Math.max(1, this.trail)))\n      this.setScale([1, 1, s])\n    }\n    this._flown += this.speed * delta\n    const end = this.tracerLength\n    if (this._flown >= end + this.trail * 0.2) { this.remove({ immediate: true }); return }\n    const at = Math.min(this._flown, Math.max(0, end - this.trail * 0.5))\n    this.setWorldPosition([this._start[0] + this._dir[0] * at, this._start[1] + this._dir[1] * at, this._start[2] + this._dir[2] * at])\n  }\n}\n",
    "scriptVars": {}
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
