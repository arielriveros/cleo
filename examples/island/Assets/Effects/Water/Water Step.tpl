{
  "id": "4b2c9462b77331980f7c1389e414e165",
  "name": "Water Step",
  "nodeJson": {
    "id": "0b1dc405e35f0bd096352d58447dd4c4",
    "name": "Water Step",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "6ba328743132238a265750667dc47ffd",
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
                "id": "5b1fcb152b673a5d2f5632409925e664",
                "name": "Burst",
                "enabled": true,
                "capacity": 4,
                "simSpace": "world",
                "duration": 1,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 10198179,
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
                          "count": 1,
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
                      "radius": 0.01,
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
                      "range": [0.6400000000000001, 0.6400000000000001]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "direction",
                      "direction": [0, 0, 1],
                      "spread": 5,
                      "speed": [0, 0.15],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.8, 1]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [1, 1, 1, 1],
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
                      "intensity": 1.3
                    }
                  }
                ],
                "update": [],
                "render": {
                  "mode": "billboard",
                  "alignment": "camera",
                  "blend": "alpha",
                  "stretch": 0.1,
                  "cutoff": 0.5,
                  "textureId": "32162ff79a6b37b8d558c624bee2aa6d",
                  "flipbook": {
                    "columns": 5,
                    "rows": 5,
                    "frames": 24,
                    "mode": "life",
                    "fps": 30,
                    "cycles": 1,
                    "randomStart": false,
                    "blend": true
                  },
                  "softness": 0.15,
                  "emissive": 1,
                  "lit": true,
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
                "id": "c28df9f40416efede15ae62e4649c95e",
                "name": "Droplets",
                "enabled": true,
                "capacity": 16,
                "simSpace": "world",
                "duration": 1,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 8021599,
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
                          "count": 6,
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
                      "range": [0.45, 0.9]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "direction",
                      "direction": [0, 3, 1],
                      "spread": 70,
                      "speed": [0.8, 1.6],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.03, 0.05]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [1, 1, 1, 1],
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
                      "intensity": 1.3
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
                      "bodies": false,
                      "depth": true,
                      "planes": [],
                      "radius": 1,
                      "restitution": 0.05,
                      "friction": 0.9,
                      "lifetimeLoss": 1,
                      "kill": true,
                      "thickness": 0.5
                    }
                  }
                ],
                "render": {
                  "mode": "billboard",
                  "alignment": "velocity",
                  "blend": "alpha",
                  "stretch": 0.25,
                  "cutoff": 0.5,
                  "textureId": "5a51f506105d473b4ffc21d560cbb017",
                  "flipbook": {
                    "columns": 7,
                    "rows": 4,
                    "frames": 24,
                    "mode": "fps",
                    "fps": 30,
                    "cycles": 1,
                    "randomStart": true,
                    "blend": true
                  },
                  "softness": 0.05,
                  "emissive": 1,
                  "lit": true,
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
              "center": [0, 0.5, 0],
              "extents": [1.2, 1, 1.2]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "b507d6af6dd2b2826e08960f6d2ba77f",
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
        "value": "2a9d09fdedd39a6966f91087cbe2ddb4",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * Valley — a fire-and-forget effect: the pond's splashes. Attach to the root of an effect template. On\n * start it plays every Particle System below it, and removes the whole effect `lifetime` seconds later.\n *\n * The pond's Water Volume spawns these by template name (its Splash Template and Wade Splash Template).\n */\nexport default class ValleyFxNode extends Node {\n  /** Seconds before the effect removes itself: at least as long as its longest particle lives. */\n  @attribute\n  public lifetime: number = 1.2\n\n  private _age: number = 0\n\n  onStart() {\n    this._age = 0\n    const walk = (node: Node) => {\n      for (const child of node.children) {\n        // play(), not restart(): a fresh instance is already playing if its system plays on start.\n        if (child.nodeType === 'particleSystem') (child as any).play?.()\n        walk(child)\n      }\n    }\n    walk(this)\n  }\n\n  onUpdate(delta: number) {\n    this._age += delta\n    if (this._age >= this.lifetime) this.remove()\n  }\n}\n",
    "scriptVars": {
      "lifetime": 1.2
    }
  },
  "textureIds": [
    "32162ff79a6b37b8d558c624bee2aa6d",
    "5a51f506105d473b4ffc21d560cbb017"
  ],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
