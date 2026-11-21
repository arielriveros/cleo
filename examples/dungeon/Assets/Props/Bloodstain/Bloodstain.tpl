{
  "id": "e41fcddeaffe4f6e9cda68978d211142",
  "name": "Bloodstain",
  "nodeJson": {
    "id": "96489ffa3952882552ac0a0f3627dcdc",
    "name": "Bloodstain",
    "type": "trigger",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "1b604b314823dbc2aea12632c3804c84",
        "name": "Pool",
        "type": "decal",
        "position": [-0.0408, 0, -0.0288],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "7651d50953d9ea7bacd6a0af5c7e7007",
            "access": "public"
          }
        },
        "spawnOnStart": true,
        "decal": {
          "size": [1.0151999999999999, 0.8, 1.7424],
          "opacity": 1,
          "sortOrder": 1,
          "angleFade": 0.35,
          "depthFade": 0.25,
          "affects": {
            "albedo": true,
            "normal": true,
            "surface": true,
            "emissive": false
          },
          "receivers": "all",
          "pattern": "material",
          "material": {
            "type": "pbr",
            "baseColor": [1, 1, 1],
            "metallic": 0,
            "roughness": 1,
            "reflectance": 0.5,
            "opacity": 1,
            "emissiveFactor": [0, 0, 0],
            "emissiveIntensity": 1,
            "textures": {
              "baseColorTexture": "c24cbe345d6f4adc9471675a380eeacc",
              "metallicRoughnessTexture": "fc35266fc7e27d16264afa5db2821b72",
              "occlusionMap": "fc35266fc7e27d16264afa5db2821b72",
              "normalMap": "698ccaf1d3ca579550c0efac8df3b9c2"
            },
            "config": {
              "side": "front",
              "wireframe": false,
              "transparent": false,
              "castShadow": false,
              "probeable": true
            }
          },
          "albedoOpacity": 1,
          "flipbook": {
            "columns": 6,
            "rows": 3,
            "frames": 16,
            "fps": 5.714,
            "loop": false,
            "blend": true
          }
        }
      },
      {
        "id": "0261b22f4ab5f31949a5bf18d24a7e8c",
        "name": "Glow",
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
                "id": "986674ac034ccbecb93c172e40ee4dc1",
                "name": "Motes",
                "enabled": true,
                "capacity": 64,
                "simSpace": "world",
                "duration": 5,
                "looping": true,
                "prewarm": false,
                "startDelay": 0,
                "seed": 3318369,
                "maxLod": 99,
                "spawn": [
                  {
                    "type": "spawnRate",
                    "enabled": true,
                    "params": {
                      "rate": 14,
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
                  }
                ],
                "init": [
                  {
                    "type": "shape",
                    "enabled": true,
                    "params": {
                      "shape": "circle",
                      "radius": 0.35,
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
                      "range": [0.8, 1.6]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "direction",
                      "direction": [0, 1, 0],
                      "spread": 15,
                      "speed": [0.2, 0.6],
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
                      "colorA": [1, 0.1, 0.06, 1],
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
                      "intensity": 0.00628
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
              "center": [0, 0.5, 0],
              "extents": [0.8, 1, 0.8]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "37ae8e1e19ee8bdb42445ff995a4180f",
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
        "value": "b80df9c4542198fbba05a9cf313197a1",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { save, find, attribute } from 'cleo/decorators'\n\n/**\n * Hollow Keep — the bloodstain left where the player died, holding every soul they carried. Attach to\n * the root of the `Bloodstain` template; the GameManager instantiates it on every death and sets `souls`.\n *\n * Touch it to get the souls back. Die again before you do and the manager replaces it with a new one —\n * the old souls are gone for good. See SoulsBonfire for the interactable protocol.\n *\n * It is also the pool of blood where the player last died: its decal children play their flipbook (a pool\n * spreading) when it appears. With no souls in it, it is only that: its `Glow` hides and there is nothing\n * to retrieve.\n *\n * The template's root is Saved: a save made after a death keeps the stain where it lies, with its souls.\n */\nexport default class SoulsBloodstainNode extends Node {\n  @save\n  @attribute\n  public souls: number = 0\n\n  @find('GameManager')\n  private _gm: Node = null\n  private _taken: boolean = false\n  private _shown: boolean = false\n\n  onStart() {\n    ;(this._gm as any)?.registerInteractable?.(this)\n  }\n\n  onUpdate() {\n    // On the first frame, once the manager has set `souls` (it does so right after instantiating).\n    if (this._shown) return\n    this._shown = true\n    for (const c of this.children) {\n      if (c.nodeType === 'decal') (c as any).playFlipbook?.()\n      else if (c.name === 'Glow' && !(this.souls > 0)) c.visible = false\n    }\n  }\n\n  onDespawn() {\n    ;(this._gm as any)?.unregisterInteractable?.(this)\n  }\n\n  public canInteract(player: Node): boolean { return !this._taken && this.souls > 0 && !(player as any)?.isDead }\n  public promptText(player: Node): string { return 'Retrieve souls' }\n\n  public interact(player: Node): void {\n    if (this._taken) return\n    this._taken = true\n    const p = player as any\n    p.playGesture?.('Pickup', 0.8)\n    p.addSouls?.(this.souls)\n    const gm = this._gm as any\n    gm?.onBloodstainRecovered?.(this)\n    gm?.notice?.('Souls retrieved')\n    this.remove()\n  }\n}\n",
    "scriptVars": {},
    "sensor": {
      "shapes": [
        {
          "type": "cylinder",
          "radius": 1.2,
          "height": 3,
          "numSegments": 16,
          "offset": [0, 1, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "layer": 1,
      "mask": -1,
      "detectTriggers": false,
      "continuous": false,
      "enabled": true
    },
    "saved": true
  },
  "textureIds": [
    "c24cbe345d6f4adc9471675a380eeacc",
    "698ccaf1d3ca579550c0efac8df3b9c2",
    "fc35266fc7e27d16264afa5db2821b72"
  ],
  "scripts": {}
}
