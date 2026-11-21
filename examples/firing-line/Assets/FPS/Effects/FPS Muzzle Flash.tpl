{
  "id": "b5975be87885ba7757b0e304c5d72ee1",
  "name": "FPS Muzzle Flash",
  "nodeJson": {
    "id": "c9cba761897a8d1ce32d7884bb2d9249",
    "name": "FPS Muzzle Flash",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "b8b4190a19e4a542a1b579687aba656d",
        "name": "Flash",
        "type": "particleSystem",
        "position": [0, 0, 0],
        "rotation": [90, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "particleSystem": {
          "system": {
            "version": 1,
            "emitters": [
              {
                "id": "b8b9fd2ffdd68c799db550df48ecde6f",
                "name": "Core",
                "enabled": true,
                "capacity": 16,
                "simSpace": "world",
                "duration": 0.2,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 7555430,
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
                          "count": 3,
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
                      "shape": "cone",
                      "radius": 0.01,
                      "thickness": 1,
                      "arc": 360,
                      "angle": 8,
                      "box": [1, 1, 1],
                      "offset": [0, 0, 0],
                      "orbit": 0
                    }
                  },
                  {
                    "type": "lifetime",
                    "enabled": true,
                    "params": {
                      "range": [0.035, 0.06]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "shape",
                      "direction": [0, 1, 0],
                      "spread": 0,
                      "speed": [0.5, 1.5],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.28, 0.42]
                    }
                  },
                  {
                    "type": "rotation",
                    "enabled": true,
                    "params": {
                      "angle": [0, 360],
                      "spin": [0, 0]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [1, 0.78, 0.4, 1],
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
                      "intensity": 2.46
                    }
                  }
                ],
                "update": [
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
                  "stretchRange": [1, 1],
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
                  "nearFade": 0,
                  "emissive": 1,
                  "lit": false,
                  "translucency": 0,
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
                "id": "c64c5d9c12206697ed20133123d42831",
                "name": "Sparks",
                "enabled": true,
                "capacity": 32,
                "simSpace": "world",
                "duration": 0.2,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 2489760,
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
                          "count": 10,
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
                      "shape": "cone",
                      "radius": 0.015,
                      "thickness": 1,
                      "arc": 360,
                      "angle": 16,
                      "box": [1, 1, 1],
                      "offset": [0, 0, 0],
                      "orbit": 0
                    }
                  },
                  {
                    "type": "lifetime",
                    "enabled": true,
                    "params": {
                      "range": [0.08, 0.2]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "shape",
                      "direction": [0, 1, 0],
                      "spread": 0,
                      "speed": [5, 12],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.012, 0.028]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [1, 0.7, 0.25, 1],
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
                      "intensity": 2.15
                    }
                  }
                ],
                "update": [
                  {
                    "type": "drag",
                    "enabled": true,
                    "params": {
                      "coefficient": 1
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
                  "stretch": 1.4,
                  "stretchRange": [1, 1],
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
                  "nearFade": 0,
                  "emissive": 1,
                  "lit": false,
                  "translucency": 0,
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
                "id": "ab801d12a1a506773e49f7ae27bb11ab",
                "name": "Smoke",
                "enabled": true,
                "capacity": 16,
                "simSpace": "world",
                "duration": 1,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 11558867,
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
                          "count": 3,
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
                      "shape": "cone",
                      "radius": 0.02,
                      "thickness": 1,
                      "arc": 360,
                      "angle": 12,
                      "box": [1, 1, 1],
                      "offset": [0, 0, 0],
                      "orbit": 0
                    }
                  },
                  {
                    "type": "lifetime",
                    "enabled": true,
                    "params": {
                      "range": [0.5, 0.9]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "shape",
                      "direction": [0, 1, 0],
                      "spread": 0,
                      "speed": [0.4, 1.1],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.1, 0.18]
                    }
                  },
                  {
                    "type": "rotation",
                    "enabled": true,
                    "params": {
                      "angle": [0, 360],
                      "spin": [-40, 40]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [0.62, 0.6, 0.57, 0.25],
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
                      "intensity": 1
                    }
                  }
                ],
                "update": [
                  {
                    "type": "drag",
                    "enabled": true,
                    "params": {
                      "coefficient": 1.2
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
                            "a": 0.5
                          },
                          {
                            "t": 0.7,
                            "a": 0.5
                          },
                          {
                            "t": 1,
                            "a": 0
                          }
                        ]
                      }
                    }
                  },
                  {
                    "type": "sizeOverLife",
                    "enabled": true,
                    "params": {
                      "curve": {
                        "keys": [
                          {
                            "t": 0,
                            "v": 0.5
                          },
                          {
                            "t": 1,
                            "v": 2.2
                          }
                        ]
                      }
                    }
                  }
                ],
                "render": {
                  "mode": "billboard",
                  "alignment": "camera",
                  "blend": "alpha",
                  "stretch": 0.1,
                  "stretchRange": [1, 1],
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
                  "softness": 0.6,
                  "nearFade": 0,
                  "emissive": 1,
                  "lit": true,
                  "translucency": 0,
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
              "center": [0, 0, 0.5],
              "extents": [1, 1, 1.5]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "6db313284b682dcc2d81d0986941fdb6",
          "playOnStart": true,
          "simulationSpeed": 1,
          "spawnRateScale": 1,
          "tint": [1, 1, 1, 1]
        }
      },
      {
        "id": "1589a145e3addfedfbc4eb7545a692a7",
        "name": "Light",
        "type": "light",
        "position": [0, 0, 0.15],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "lightType": "point",
        "castShadows": false,
        "light": {
          "unit": "photometric",
          "color": [1, 0.72, 0.4],
          "intensity": 9000,
          "range": 9,
          "sourceRadius": 0.05,
          "legacyFalloff": false
        },
        "bake": false
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "962bd30f286d2f3c93402db5033c60c4",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * FPS example — a fire-and-forget effect (muzzle flash, impact, blood). Attach to the root of an effect\n * template. On start it plays every Particle System child (a `burstCount` > 0 bursts that many instead),\n * fades every point light child over `lifetime`, and removes itself when that time is up.\n *\n * The look is the template's particle systems; this script only owns the lifetime.\n */\n/** Lights alive across all effects: a firefight's flashes beyond this many keep their particles but not a light. */\nconst MAX_LIVE_LIGHTS = 3\nlet liveLights = 0\n\nexport default class FpsFxNode extends Node {\n  @attribute\n  public lifetime: number = 0.6\n  /** Particles per child system on start. 0 leaves them to their own spawn rate and bursts. */\n  @attribute\n  public burstCount: number = 0\n  /** Fade the lights to nothing over `lifetime` (a flash's light falls off fast: this squares it). */\n  @attribute\n  public lightFalloff: number = 2\n\n  private _age: number = 0\n  private _lights: any[] = []\n  private _holdsLight: boolean = false\n  private _intensities: number[] = []\n\n  onStart() {\n    this._age = 0\n    const walk = (node: Node) => {\n      for (const child of node.children) {\n        const c = child as any\n        if (child.nodeType === 'particleSystem') {\n          c.play?.()\n          if (this.burstCount > 0) c.burst?.(this.burstCount)\n        }\n        if (child.nodeType === 'light' && c.light) {\n          // Every live light is paid for by the lighting pass, and a spawned light is also a scene change.\n          if (liveLights >= MAX_LIVE_LIGHTS && !this._holdsLight) c.visible = false\n          else {\n            if (!this._holdsLight) { this._holdsLight = true; liveLights++ }\n            this._lights.push(c.light)\n            this._intensities.push(c.light.intensity)\n          }\n        }\n        walk(child)\n      }\n    }\n    walk(this)\n  }\n\n  onUpdate(delta: number) {\n    this._age += delta\n    const k = Math.pow(Math.max(0, 1 - this._age / Math.max(0.01, this.lifetime)), this.lightFalloff)\n    for (let i = 0; i < this._lights.length; i++) this._lights[i].intensity = this._intensities[i] * k\n    if (this._age >= this.lifetime) {\n      if (this._holdsLight) { this._holdsLight = false; liveLights = Math.max(0, liveLights - 1) }\n      this.remove({ immediate: true })\n    }\n  }\n}\n",
    "scriptVars": {
      "lifetime": 0.7,
      "lightFalloff": 4
    }
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
