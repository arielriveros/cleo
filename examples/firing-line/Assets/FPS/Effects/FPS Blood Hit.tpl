{
  "id": "8401a60a82c526c9e9c51f9b27f16442",
  "name": "FPS Blood Hit",
  "nodeJson": {
    "id": "78e4bafa5dd85065ec2a0ac516179549",
    "name": "FPS Blood Hit",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "5e02b9db65bd8f470e654dae0d1f3f9e",
        "name": "Blood",
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
                "id": "96decfd602f7fde3026069d2c60bb1ec",
                "name": "Droplets",
                "enabled": true,
                "capacity": 48,
                "simSpace": "world",
                "duration": 1,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 15543221,
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
                          "count": 18,
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
                      "speed": [0.8, 3.2],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.014, 0.034]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [0.3, 0.012, 0.012, 1],
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
                    "type": "gravity",
                    "enabled": true,
                    "params": {
                      "scale": 1.6
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
                  "blend": "alpha",
                  "stretch": 0.4,
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
              },
              {
                "id": "17bf49f10ce1c8fe83c9545120261957",
                "name": "Mist",
                "enabled": true,
                "capacity": 12,
                "simSpace": "world",
                "duration": 1,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 16205650,
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
                          "count": 4,
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
                      "radius": 0.04,
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
                      "range": [0.3, 0.55]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "radial",
                      "direction": [0, 1, 0],
                      "spread": 0,
                      "speed": [0.2, 0.8],
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
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [0.4, 0.02, 0.02, 0.35],
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
                            "a": 0.6
                          },
                          {
                            "t": 0.7,
                            "a": 0.6
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
                            "v": 0.6
                          },
                          {
                            "t": 1,
                            "v": 1.8
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
                  "softness": 0.5,
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
              "center": [0, 0, 0],
              "extents": [1.2, 1.2, 1.2]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "4638c230b87795e783fe4c6f2e2c3d25",
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
        "value": "962bd30f286d2f3c93402db5033c60c4",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * FPS example — a fire-and-forget effect (muzzle flash, impact, blood). Attach to the root of an effect\n * template. On start it plays every Particle System child (a `burstCount` > 0 bursts that many instead),\n * fades every point light child over `lifetime`, and removes itself when that time is up.\n *\n * The look is the template's particle systems; this script only owns the lifetime.\n */\n/** Lights alive across all effects: a firefight's flashes beyond this many keep their particles but not a light. */\nconst MAX_LIVE_LIGHTS = 3\nlet liveLights = 0\n\nexport default class FpsFxNode extends Node {\n  @attribute\n  public lifetime: number = 0.6\n  /** Particles per child system on start. 0 leaves them to their own spawn rate and bursts. */\n  @attribute\n  public burstCount: number = 0\n  /** Fade the lights to nothing over `lifetime` (a flash's light falls off fast: this squares it). */\n  @attribute\n  public lightFalloff: number = 2\n\n  private _age: number = 0\n  private _lights: any[] = []\n  private _holdsLight: boolean = false\n  private _intensities: number[] = []\n\n  onStart() {\n    this._age = 0\n    const walk = (node: Node) => {\n      for (const child of node.children) {\n        const c = child as any\n        if (child.nodeType === 'particleSystem') {\n          c.play?.()\n          if (this.burstCount > 0) c.burst?.(this.burstCount)\n        }\n        if (child.nodeType === 'light' && c.light) {\n          // Every live light is paid for by the lighting pass, and a spawned light is also a scene change.\n          if (liveLights >= MAX_LIVE_LIGHTS && !this._holdsLight) c.visible = false\n          else {\n            if (!this._holdsLight) { this._holdsLight = true; liveLights++ }\n            this._lights.push(c.light)\n            this._intensities.push(c.light.intensity)\n          }\n        }\n        walk(child)\n      }\n    }\n    walk(this)\n  }\n\n  onUpdate(delta: number) {\n    this._age += delta\n    const k = Math.pow(Math.max(0, 1 - this._age / Math.max(0.01, this.lifetime)), this.lightFalloff)\n    for (let i = 0; i < this._lights.length; i++) this._lights[i].intensity = this._intensities[i] * k\n    if (this._age >= this.lifetime) {\n      if (this._holdsLight) { this._holdsLight = false; liveLights = Math.max(0, liveLights - 1) }\n      this.remove({ immediate: true })\n    }\n  }\n}\n",
    "scriptVars": {
      "lifetime": 1.2
    }
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
