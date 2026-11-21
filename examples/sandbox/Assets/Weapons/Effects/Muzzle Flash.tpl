{
  "id": "09aa8c9b72494d9905d6f33b96ed5dc6",
  "name": "Muzzle Flash",
  "nodeJson": {
    "id": "29786a4cda4ab133862c35469c1f6725",
    "name": "Muzzle Flash",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "eb11c94ee759db2b465661e41c9cd769",
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
                "id": "47e1dc9f1509271e6d1c191a6c5c448d",
                "name": "Core",
                "enabled": true,
                "capacity": 16,
                "simSpace": "world",
                "duration": 0.2,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 13440615,
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
                      "range": [0.22, 0.34]
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
                      "intensity": 4.8
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
                "id": "dbb71a4f0282a99bca2d6eedb64241c1",
                "name": "Sparks",
                "enabled": true,
                "capacity": 32,
                "simSpace": "world",
                "duration": 0.2,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 6019072,
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
                      "intensity": 4.2
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
              }
            ],
            "bounds": {
              "center": [0, 0.5, 0],
              "extents": [1, 1.5, 1]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "5487a2ff488e7d1b1d4bad08c5dd3146",
          "playOnStart": true,
          "simulationSpeed": 1,
          "spawnRateScale": 1,
          "tint": [1, 1, 1, 1],
          "exposureWeight": 0.1
        }
      },
      {
        "id": "cd7701e58d1c44747721441fcaa48546",
        "name": "Smoke",
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
                "id": "1360e2e60b06aecf0420fbe151ddd005",
                "name": "Smoke",
                "enabled": true,
                "capacity": 16,
                "simSpace": "world",
                "duration": 1,
                "looping": false,
                "prewarm": false,
                "startDelay": 0,
                "seed": 10495852,
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
              "center": [0, 0.5, 0],
              "extents": [1, 1.5, 1]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "e5394a62a9182512b885f2a8bb9c6db8",
          "playOnStart": true,
          "simulationSpeed": 1,
          "spawnRateScale": 1,
          "tint": [1, 1, 1, 1]
        }
      },
      {
        "id": "c2194c90c87916bd10c809aa3667936f",
        "name": "Light",
        "type": "light",
        "position": [0, 0, 0.3],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "lightType": "point",
        "castShadows": false,
        "bake": false,
        "light": {
          "unit": "photometric",
          "color": [1, 0.72, 0.4],
          "intensity": 1500,
          "range": 5,
          "sourceRadius": 0.05,
          "legacyFalloff": false
        }
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "7a7cb7da81b55c9894a45bad7c1c1861",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * A Sandbox shot effect that plays once and goes: the muzzle flash, a bullet's impact. Attach to the root of the\n * effect's template; SandboxGun instantiates it. On start it plays every Particle System under it, fades every\n * light under it over `lifetime` (`lightFalloff` squares the fade, so a flash's light drops fast), and removes\n * itself when `lifetime` is up. The look is the template's particle systems and lights.\n */\nexport default class SandboxShotFxNode extends Node {\n    @attribute({ min: 0.05, max: 10, step: 0.05 })\n    public lifetime: number = 0.6\n\n    @attribute({ min: 0.5, max: 8, step: 0.5 })\n    public lightFalloff: number = 2\n\n    private _age: number = 0\n    private _lights: { light: any, intensity: number }[] = []\n\n    onStart() {\n        this._age = 0\n        const walk = (node: Node) => {\n            for (const child of node.children) {\n                const c = child as any\n                if (child.nodeType === 'particleSystem') c.play?.()\n                if (child.nodeType === 'light' && c.light) this._lights.push({ light: c.light, intensity: c.light.intensity })\n                walk(child)\n            }\n        }\n        walk(this)\n    }\n\n    onUpdate(delta: number) {\n        this._age += delta\n        const k = Math.pow(Math.max(0, 1 - this._age / Math.max(0.01, this.lifetime)), this.lightFalloff)\n        for (const l of this._lights) l.light.intensity = l.intensity * k\n        if (this._age >= this.lifetime) this.remove({ immediate: true })\n    }\n}\n",
    "scriptVars": {
      "lifetime": 0.7,
      "lightFalloff": 4
    }
  },
  "scripts": {},
  "textureIds": []
}
