{
  "id": "63739a41c3e19fd18e43f58b038c2ff1",
  "name": "Hit Spark",
  "nodeJson": {
    "id": "420d23b76a720e20b3383d097229002e",
    "name": "Hit Spark",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "66a981ebd58b71912e8dd6aec8d4b733",
        "name": "Particles",
        "type": "particleSystem",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "particleSystem": {
          "system": {
            "version": 1,
            "emitters": [
              {
                "id": "c4eeb980d06f4d41aa1efefe865f6fbb",
                "name": "Sparks",
                "enabled": true,
                "capacity": 64,
                "simSpace": "world",
                "duration": 1,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 7489496,
                "maxLod": 99,
                "spawn": [
                  {
                    "type": "spawnRate",
                    "enabled": true,
                    "params": {
                      "rate": 0,
                      "rateOverTime": {
                        "keys": [
                          {
                            "t": 0,
                            "v": 1
                          },
                          {
                            "t": 1,
                            "v": 1
                          }
                        ]
                      },
                      "perDistance": 0
                    }
                  },
                  {
                    "type": "spawnBurst",
                    "enabled": true,
                    "params": {
                      "bursts": [
                        {
                          "time": 0,
                          "count": 24,
                          "cycles": 1,
                          "interval": 1,
                          "probability": 1
                        }
                      ]
                    }
                  }
                ],
                "init": [
                  {
                    "type": "shape",
                    "enabled": true,
                    "params": {
                      "shape": "sphere",
                      "radius": 0.05,
                      "thickness": 1,
                      "arc": 360,
                      "angle": 20,
                      "box": [1, 1, 1],
                      "offset": [0, 0, 0],
                      "orbit": 0
                    }
                  },
                  {
                    "type": "lifetime",
                    "enabled": true,
                    "params": {
                      "range": [0.5, 1.1]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "radial",
                      "direction": [0, 1, 0],
                      "spread": 0,
                      "speed": [2, 6],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.02, 0.05]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [1, 0.55, 0.15, 1],
                      "colorB": [1, 0.5, 0.2, 1],
                      "gradient": {
                        "color": [
                          {
                            "t": 0,
                            "c": [1, 1, 1]
                          },
                          {
                            "t": 1,
                            "c": [1, 1, 1]
                          }
                        ],
                        "alpha": [
                          {
                            "t": 0,
                            "a": 1
                          },
                          {
                            "t": 1,
                            "a": 1
                          }
                        ]
                      },
                      "intensity": 0.00837
                    }
                  }
                ],
                "update": [
                  {
                    "type": "gravity",
                    "enabled": true,
                    "params": {
                      "scale": 1
                    }
                  },
                  {
                    "type": "drag",
                    "enabled": true,
                    "params": {
                      "coefficient": 0.5
                    }
                  },
                  {
                    "type": "collision",
                    "enabled": true,
                    "params": {
                      "bodies": true,
                      "depth": true,
                      "planes": [],
                      "radius": 1,
                      "restitution": 0.45,
                      "friction": 0.3,
                      "lifetimeLoss": 0.1,
                      "kill": false,
                      "thickness": 0.5
                    }
                  },
                  {
                    "type": "colorOverLife",
                    "enabled": true,
                    "params": {
                      "gradient": {
                        "color": [
                          {
                            "t": 0,
                            "c": [1, 1, 1]
                          },
                          {
                            "t": 1,
                            "c": [1, 1, 1]
                          }
                        ],
                        "alpha": [
                          {
                            "t": 0,
                            "a": 0
                          },
                          {
                            "t": 0.15,
                            "a": 1
                          },
                          {
                            "t": 0.7,
                            "a": 1
                          },
                          {
                            "t": 1,
                            "a": 0
                          }
                        ]
                      }
                    }
                  }
                ],
                "render": {
                  "mode": "billboard",
                  "alignment": "velocity",
                  "blend": "additive",
                  "stretch": 0.8,
                  "cutoff": 0.5,
                  "textureId": null,
                  "flipbook": {
                    "columns": 1,
                    "rows": 1,
                    "frames": 1,
                    "mode": "life",
                    "fps": 24,
                    "cycles": 1,
                    "randomStart": false,
                    "blend": true
                  },
                  "softness": 0,
                  "emissive": 1,
                  "lit": false,
                  "normalTextureId": null,
                  "ormTextureId": null,
                  "normalStrength": 1,
                  "roughness": 1,
                  "metallic": 0,
                  "mesh": "cube",
                  "modelId": null,
                  "meshData": null,
                  "sort": false,
                  "sortingOrder": 0
                }
              }
            ],
            "bounds": {
              "center": [0, -0.5, 0],
              "extents": [2.5, 2, 2.5]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "3e9fe8dfc633280525d255e5859ad80a",
          "playOnStart": true,
          "simulationSpeed": 1,
          "spawnRateScale": 1,
          "tint": [1, 1, 1, 1]
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
      "lifetime": 0.8
    }
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
