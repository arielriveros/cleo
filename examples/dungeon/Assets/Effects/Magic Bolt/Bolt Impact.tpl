{
  "id": "f94a1ad75329c1b99d11a30a7444eb97",
  "name": "Bolt Impact",
  "nodeJson": {
    "id": "0f5914b9abbb1c71ac65d070994f946d",
    "name": "Bolt Impact",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "63e041cabab994e428f619355e7119cc",
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
                "id": "5acf5fff0c4a5f2d13c110f4929250fe",
                "name": "Burst",
                "enabled": true,
                "capacity": 128,
                "simSpace": "world",
                "duration": 1,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 1734278,
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
                          "count": 48,
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
                      "radius": 0.1,
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
                      "range": [0.3, 0.7]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "radial",
                      "direction": [0, 1, 0],
                      "spread": 0,
                      "speed": [2, 5],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.05, 0.12]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [0.55, 0.75, 1, 1],
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
                      "intensity": 0.862
                    }
                  }
                ],
                "update": [
                  {
                    "type": "drag",
                    "enabled": true,
                    "params": {
                      "coefficient": 2
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
                  "alignment": "camera",
                  "blend": "additive",
                  "stretch": 0.1,
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
              },
              {
                "id": "ef59f56da028fa73102c144b6be5b93f",
                "name": "Skitter",
                "enabled": true,
                "capacity": 64,
                "simSpace": "world",
                "duration": 1.6,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 7639164,
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
                          "count": 22,
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
                      "radius": 0.1,
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
                      "range": [0.9, 1.6]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "direction",
                      "direction": [0, 1, 0],
                      "spread": 75,
                      "speed": [2.5, 5],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.04, 0.08]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [0.55, 0.8, 1, 1],
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
                      "intensity": 0.862
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
                      "coefficient": 0.3
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
                      "restitution": 0.6,
                      "friction": 0.25,
                      "lifetimeLoss": 0,
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
                  "stretch": 0.4,
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
              "center": [0, 0, 0],
              "extents": [2.5, 2, 2.5]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "7d55906f17acd961b22dedb8ddbcf7ec",
          "playOnStart": true,
          "simulationSpeed": 1,
          "spawnRateScale": 1,
          "tint": [1, 1, 1, 1],
          "exposureWeight": 0.3
        }
      },
      {
        "id": "a4d19baa7e9843a318f6123b6a4aaf71",
        "name": "Flash",
        "type": "light",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "lightType": "point",
        "castShadows": false,
        "light": {
          "unit": "photometric",
          "color": [0.5, 0.7, 1],
          "intensity": 350,
          "range": 6,
          "sourceRadius": 0.1,
          "legacyFalloff": false
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
      "lifetime": 1.2
    }
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
