{
  "id": "595a38f2881b9a9382adfc40b7345a3f",
  "name": "Tracer",
  "nodeJson": {
    "id": "cba491f1439a59a65a26ff6f28ffdb1c",
    "name": "Tracer",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "219dce6fd52bc3bc6fdd8e09613b8f9e",
        "name": "Streak",
        "type": "model",
        "position": [0, 0, -2.5],
        "rotation": [0, 0, 0],
        "scale": [0.012, 0.012, 5],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "e1f73e7f57770d79a93fd78d137cd948",
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
            "opacity": 1,
            "emissiveFactor": [1, 0.78, 0.4],
            "textures": {},
            "config": {
              "side": "front",
              "wireframe": false,
              "transparent": false,
              "castShadow": false,
              "probeable": true
            },
            "emissiveIntensity": 6,
            "emissiveExposureWeight": 0.1
          }
        }
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "1c1a06406a9d09a09b5f2e3970ad897f",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * A Sandbox tracer: a glowing streak that flies from the muzzle to where the shot ended and is gone. Attach to the\n * root of the tracer's template (its streak a mesh along +Z, `trail` metres long, ending at the root); SandboxGun\n * instantiates it at the muzzle, turned along the shot, and sets `tracerLength`. The streak is shortened for a shot\n * shorter than it, and never flies past the shot's end.\n */\nexport default class SandboxTracerNode extends Node {\n    /** Set by the gun: from the muzzle to the end of the shot, m. */\n    public tracerLength: number = 0\n\n    /** How fast the streak flies, m/s. */\n    @attribute({ min: 10, max: 2000, step: 10 })\n    public speed: number = 380\n\n    /** The streak's length, m (its mesh's). */\n    @attribute({ min: 0.1, max: 20, step: 0.1 })\n    public trail: number = 5\n\n    private _flown: number = 0\n    private _start: number[] | null = null\n    private _dir: number[] = [0, 0, 1]\n\n    onUpdate(delta: number) {\n        if (!this._start) {\n            this.updateTransforms(this.parent ? this.parent.worldTransform : null)\n            const p = this.worldPosition, f = this.worldForward\n            this._start = [p[0], p[1], p[2]]\n            this._dir = [f[0], f[1], f[2]]\n            this.setScale([1, 1, Math.min(1, Math.max(0.05, this.tracerLength / Math.max(0.1, this.trail)))])\n        }\n        this._flown += this.speed * delta\n        if (this._flown >= this.tracerLength + this.trail * 0.2) { this.remove({ immediate: true }); return }\n        // The head of the streak at the root: it flies until its head reaches the end.\n        const at = Math.min(this._flown, this.tracerLength)\n        this.setWorldPosition([this._start[0] + this._dir[0] * at, this._start[1] + this._dir[1] * at, this._start[2] + this._dir[2] * at])\n    }\n}\n",
    "scriptVars": {
      "trail": 5
    }
  },
  "scripts": {},
  "textureIds": []
}
