{
  "id": "0d50816841b85146184ecbe552f5af11",
  "name": "Message",
  "nodeJson": {
    "id": "f81649452fd45a55f3a3b67472b5b964",
    "name": "Message",
    "type": "trigger",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "e53026510810c149e707ee5abfb9c5b6",
        "name": "Glyph",
        "type": "model",
        "position": [0, 0.02, 0],
        "rotation": [0, 0, 0],
        "scale": [0.7, 0.02, 0.45],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "544c0aabc12df56bc66725c986fec6eb",
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
            "baseColor": [0.9, 0.55, 0.2],
            "metallic": 0,
            "roughness": 0.85,
            "opacity": 1,
            "emissiveFactor": [1, 0.55, 0.15],
            "emissiveIntensity": 2.2,
            "emissiveExposureWeight": 0.1,
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
      },
      {
        "id": "35255df17f5a975e197232aef51e5b77",
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
                "id": "be06c205a2dfd865143d718d895980d0",
                "name": "Motes",
                "enabled": true,
                "capacity": 64,
                "simSpace": "world",
                "duration": 5,
                "looping": true,
                "prewarm": false,
                "startDelay": 0,
                "seed": 3378614,
                "maxLod": 99,
                "spawn": [
                  {
                    "type": "spawnRate",
                    "enabled": true,
                    "params": {
                      "rate": 6,
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
                      "radius": 0.3,
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
                      "range": [1, 2]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "direction",
                      "direction": [0, 1, 0],
                      "spread": 10,
                      "speed": [0.1, 0.3],
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
                      "colorA": [1, 0.6, 0.2, 1],
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
              "center": [0, 0.4, 0],
              "extents": [0.6, 0.6, 0.6]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "b995fa9b642fab0cd7255a139cab8023",
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
        "value": "ef09dbc0a32a18ded4a9db0cbfbc33d8",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { find, attribute } from 'cleo/decorators'\n\n/**\n * Hollow Keep — a readable message on the ground: tutorial hints and lore. Attach to the message's root\n * (a glowing glyph mesh and a few motes). Interact shows `title` and `text` in the HUD's message panel,\n * which closes when the player presses Interact again or walks away.\n *\n * `\\n` in `text` is a line break. See SoulsBonfire for the interactable protocol.\n */\nexport default class SoulsMessageNode extends Node {\n  @attribute\n  public title: string = 'A message'\n  @attribute\n  public text: string = 'Try rolling.'\n  @attribute\n  public hiddenUntilRevealed: boolean = false\n\n  @find('GameManager')\n  private _gm: Node = null\n\n  onStart() {\n    if (this.hiddenUntilRevealed) this.visible = false\n    else (this._gm as any)?.registerInteractable?.(this)\n  }\n\n  onDespawn() {\n    ;(this._gm as any)?.unregisterInteractable?.(this)\n  }\n\n  public reveal(): void {\n    this.visible = true\n    ;(this._gm as any)?.registerInteractable?.(this)\n  }\n\n  public canInteract(player: Node): boolean { return this.visible }\n  public promptText(player: Node): string { return 'Read message' }\n\n  public interact(player: Node): void {\n    const gm = this._gm as any\n    gm?.showMessage?.(this.title, this.text.split('\\\\n').join('\\n'), this)\n  }\n}\n",
    "scriptVars": {
      "title": "A message",
      "text": "Write the message here."
    },
    "sensor": {
      "shapes": [
        {
          "type": "cylinder",
          "radius": 1.3,
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
    }
  },
  "textureIds": [],
  "scripts": {}
}
