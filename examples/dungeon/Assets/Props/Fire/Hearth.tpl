{
  "id": "54b3c48f7680c3d0408f96212b2cbf22",
  "name": "Hearth",
  "nodeJson": {
    "id": "3dcfc52dc36de235b1fa17e7c21e74b4",
    "name": "Hearth",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "c0d16edfa64a7ba3fe962304fb6c7dce",
        "name": "Flame",
        "type": "animatedSprite",
        "position": [0, 0.7820765987350666, 0],
        "rotation": [0, 0, 0],
        "scale": [1.4673225579761067, 1.8341531974701333, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "sprite": {
          "constraints": "cylindrical",
          "tilesetId": "2be697efd23be79bad2885e81e680cc4",
          "tileset": {
            "id": "2be697efd23be79bad2885e81e680cc4",
            "name": "Bonfire Fire",
            "textureId": "0bce23a90a1e3d769b2c0e0cdfae8afe",
            "imageWidth": 1792,
            "imageHeight": 1792,
            "tileWidth": 128,
            "tileHeight": 256,
            "margin": 0,
            "spacing": 0,
            "columns": 14,
            "rows": 7,
            "overdrive": 0.5,
            "tiles": {},
            "terrains": [],
            "variantSets": [],
            "textureIds": [
              "0bce23a90a1e3d769b2c0e0cdfae8afe"
            ]
          },
          "tileIndex": 0,
          "tint": [1, 1, 1],
          "opacity": 1,
          "transparent": true,
          "side": "double",
          "wireframe": false,
          "blend": "additive",
          "exposureWeight": 0.1,
          "followLight": "Light",
          "softness": 0.15
        },
        "animation": {
          "frames": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95],
          "frameSource": "node",
          "fps": 36,
          "loop": true,
          "randomStart": true
        }
      },
      {
        "id": "c794595c8ea0f509cfd42e19c2a2702d",
        "name": "Flame",
        "type": "animatedSprite",
        "position": [0.12, 0.5503501991098617, -0.14],
        "rotation": [0, 0, 0],
        "scale": [1.0325603185757788, 1.2907003982197234, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "sprite": {
          "constraints": "cylindrical",
          "tilesetId": "2be697efd23be79bad2885e81e680cc4",
          "tileset": {
            "id": "2be697efd23be79bad2885e81e680cc4",
            "name": "Bonfire Fire",
            "textureId": "0bce23a90a1e3d769b2c0e0cdfae8afe",
            "imageWidth": 1792,
            "imageHeight": 1792,
            "tileWidth": 128,
            "tileHeight": 256,
            "margin": 0,
            "spacing": 0,
            "columns": 14,
            "rows": 7,
            "overdrive": 0.5,
            "tiles": {},
            "terrains": [],
            "variantSets": [],
            "textureIds": [
              "0bce23a90a1e3d769b2c0e0cdfae8afe"
            ]
          },
          "tileIndex": 0,
          "tint": [1, 1, 1],
          "opacity": 1,
          "transparent": true,
          "side": "double",
          "wireframe": false,
          "blend": "additive",
          "exposureWeight": 0.1,
          "followLight": "Light",
          "softness": 0.15
        },
        "animation": {
          "frames": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95],
          "frameSource": "node",
          "fps": 36,
          "loop": true,
          "randomStart": true
        }
      },
      {
        "id": "4dddfde7c690aeced20153971a13d23a",
        "name": "Embers",
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
                "id": "e08c1167daff9a4f88c31835367e48f7",
                "name": "Embers",
                "enabled": true,
                "capacity": 128,
                "simSpace": "world",
                "duration": 5,
                "looping": true,
                "prewarm": false,
                "startDelay": 0,
                "seed": 10324544,
                "maxLod": 99,
                "spawn": [
                  {
                    "type": "spawnRate",
                    "enabled": true,
                    "params": {
                      "rate": 16,
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
                      "shape": "sphere",
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
                      "range": [1.2, 2.8]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "direction",
                      "direction": [0, 1, 0],
                      "spread": 25,
                      "speed": [0.35, 0.9],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.012, 0.026]
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
                      "intensity": 0.00837
                    }
                  }
                ],
                "update": [
                  {
                    "type": "curlNoise",
                    "enabled": true,
                    "params": {
                      "strength": 0.9,
                      "frequency": 1.3,
                      "scroll": 0.4,
                      "octaves": 1
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
                            "c": [1, 0.8, 0.45]
                          },
                          {
                            "t": 0.4,
                            "c": [1, 0.45, 0.1]
                          },
                          {
                            "t": 1,
                            "c": [0.5, 0.08, 0.02]
                          }
                        ],
                        "alpha": [
                          {
                            "t": 0,
                            "a": 0
                          },
                          {
                            "t": 0.08,
                            "a": 1
                          },
                          {
                            "t": 0.7,
                            "a": 0.8
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
                "id": "b62323a6ef699d0e0c2516915dbfa305",
                "name": "Sparks",
                "enabled": true,
                "capacity": 64,
                "simSpace": "world",
                "duration": 5,
                "looping": true,
                "prewarm": false,
                "startDelay": 0,
                "seed": 12524490,
                "maxLod": 1,
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
                          "time": 0.3,
                          "count": 1,
                          "cycles": 3,
                          "interval": 1.4,
                          "probability": 0.9
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
                      "radius": 0.18,
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
                      "range": [1.4, 2.6]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "direction",
                      "direction": [0, 1, 0],
                      "spread": 65,
                      "speed": [1.6, 3.6],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.01, 0.022]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [1, 0.75, 0.35, 1],
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
                      "intensity": 0.0147
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
                      "coefficient": 0.25
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
                      "restitution": 0.45,
                      "friction": 0.35,
                      "lifetimeLoss": 0.12,
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
                            "c": [1, 0.9, 0.6]
                          },
                          {
                            "t": 0.35,
                            "c": [1, 0.55, 0.15]
                          },
                          {
                            "t": 1,
                            "c": [0.6, 0.1, 0.02]
                          }
                        ],
                        "alpha": [
                          {
                            "t": 0,
                            "a": 1
                          },
                          {
                            "t": 0.75,
                            "a": 0.9
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
                  "stretch": 0.7,
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
              "center": [0, 0.8, 0],
              "extents": [2.6, 2.4, 2.6]
            },
            "lod": {
              "enabled": true,
              "levels": [
                {
                  "distance": 12,
                  "spawnScale": 0.6,
                  "stepScale": 2
                },
                {
                  "distance": 24,
                  "spawnScale": 0.3,
                  "stepScale": 3
                }
              ],
              "cullDistance": 45,
              "scaleBursts": false
            }
          },
          "particleSystemId": "0c49497c569915d96ce2d4a0fe7aa810",
          "playOnStart": true,
          "simulationSpeed": 1,
          "spawnRateScale": 1,
          "tint": [1, 1, 1, 1],
          "followLight": "Light"
        }
      },
      {
        "id": "dbc29a3451a731ce6bed4a0e825ae3b2",
        "name": "Light",
        "type": "light",
        "position": [0, 0.75, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "lightType": "point",
        "castShadows": false,
        "light": {
          "unit": "photometric",
          "color": [1, 0.58, 0.28],
          "intensity": 1600,
          "range": 11,
          "sourceRadius": 0.08,
          "legacyFalloff": false,
          "flicker": {
            "amount": 0.18,
            "speed": 7
          }
        }
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "64c98090bd7ded3f71aa42e4ceca9229",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * Valley — a fire's light: torches, braziers, fire pits, candles, the bonfire. Attach to the fire's root;\n * it finds its parts by type, so any layout works:\n *\n *   Torch                 this script\n *   ├── Flame             animated sprite(s), following the Light\n *   ├── Ignition          optional: an animated sprite played ONCE as the fire is lit (the bonfire's)\n *   ├── Embers            particle system(s), following the Light\n *   └── Light             point light, flickering\n *\n * - FLICKER is the engine's, not this script's: the light's own Flicker (PunctualLight.flickerAmount)\n *   wanders its intensity, and the flames and embers burn on the same beat through their Follow Light.\n *   Intensity only, so a shadowed torch keeps its cached shadow map.\n * - NO DAY AND NIGHT. The light keeps its real lumens around the clock; the camera's auto exposure is what\n *   makes it vanish in sunlight and carry the road at night.\n *\n * `lit` puts the fire out and lights it again: flames hidden, embers stopped, light off. The bonfire's\n * script drives it (its `Fire` child is one of these), so an unlit bonfire is a cold one.\n *\n * LIGHTING IT, when the fire has an `Ignition` sprite (a non-looping flipbook of the fire catching, baked\n * with the FX Creator): the ignition plays from its first frame, the light flares up with it and settles,\n * the embers start at once, the smoke thickens over the whole of it, and the burning flames fade in over\n * its last `ignitionBlend` seconds while the ignition fades out, so the flare settles into the loop. A\n * fire that STARTS lit (a torch, a bonfire already lit when the scene opens) just burns.\n */\nexport default class ValleyFireLightNode extends Node {\n  /** Burning or not. */\n  @attribute\n  public lit: boolean = true\n  /** Seconds, at the end of the ignition, over which the burning flames take over from it. */\n  @attribute\n  public ignitionBlend: number = 0.5\n  /** The light's peak as the fire catches, over its full intensity. */\n  @attribute\n  public ignitionFlare: number = 1.4\n  /** Seconds into the ignition the flare peaks. */\n  @attribute\n  public ignitionFlareTime: number = 0.25\n\n  private _lights: { node: any, intensity: number }[] = []\n  private _visuals: any[] = []\n  private _sprites: { node: any, opacity: number, smoke: boolean }[] = []\n  private _ignition: any = null\n  private _shown: boolean = true\n  /** Seconds into the ignition, or -1 when none is playing. */\n  private _igniting: number = -1\n  private _ignitionLength: number = 0\n\n  onStart() {\n    const walk = (n: any) => {\n      const type = n.nodeType\n      if (type === 'light' && n.light) this._lights.push({ node: n, intensity: n.light.intensity })\n      else if (type === 'animatedSprite' && n.name === 'Ignition') this._ignition = n\n      else if (type === 'sprite' || type === 'animatedSprite' || type === 'particleSystem') {\n        this._visuals.push(n)\n        if (n.sprite) this._sprites.push({ node: n, opacity: n.sprite.opacity, smoke: n.name === 'Smoke' })\n      }\n      for (const c of n.children ?? []) walk(c)\n    }\n    for (const c of this.children) walk(c)\n    if (this._ignition) {\n      this._ignition.visible = false\n      const frames = this._ignition.frames?.length ?? 0\n      this._ignitionLength = frames > 0 ? frames / Math.max(1e-3, this._ignition.fps ?? 30) : 0\n    }\n  }\n\n  onUpdate(delta: number) {\n    if (this.lit !== this._shown) {\n      // Lit from out: the fire catches. Put out, or lit with no ignition sprite: it just changes.\n      const catches = this.lit && !this._shown && this._ignition && this._ignitionLength > 0\n      this._show(this.lit)\n      if (catches) this._ignite()\n      else this._endIgnition()\n    }\n    if (this._igniting >= 0) this._stepIgnition(delta)\n  }\n\n  private _show(lit: boolean): void {\n    this._shown = lit\n    for (const l of this._lights) l.node.light.intensity = lit ? l.intensity : 0\n    for (const node of this._visuals) {\n      if (node.nodeType === 'particleSystem') { if (lit) node.play?.(); else node.stop?.(true) }\n      else node.visible = lit\n    }\n  }\n\n  private _ignite(): void {\n    this._igniting = 0\n    const ignition = this._ignition\n    ignition.reset?.()\n    ignition.currentFrame = 0\n    ignition.sprite.opacity = 1\n    ignition.visible = true\n    this._stepIgnition(0)\n  }\n\n  private _stepIgnition(delta: number): void {\n    const t = (this._igniting += delta)\n    const length = this._ignitionLength\n    if (t >= length) { this._endIgnition(); return }\n    // The burning flames take over across the last `ignitionBlend` seconds; the smoke builds all along.\n    const blend = Math.min(Math.max(0.05, this.ignitionBlend), length)\n    const handover = Math.min(1, Math.max(0, (t - (length - blend)) / blend))\n    const build = t / length\n    for (const s of this._sprites) s.node.sprite.opacity = s.opacity * (s.smoke ? build : handover)\n    this._ignition.sprite.opacity = 1 - handover\n    // The light: up to the flare at `ignitionFlareTime`, then down to its full intensity by the end.\n    const peak = Math.max(1e-3, Math.min(this.ignitionFlareTime, length * 0.5))\n    const scale = t < peak\n      ? this.ignitionFlare * smooth(t / peak)\n      : 1 + (this.ignitionFlare - 1) * (1 - smooth((t - peak) / Math.max(1e-3, length - peak)))\n    for (const l of this._lights) l.node.light.intensity = l.intensity * scale\n  }\n\n  /** The ignition over (or cut short): the fire as it burns, the ignition hidden for next time. */\n  private _endIgnition(): void {\n    if (this._igniting < 0) return\n    this._igniting = -1\n    for (const s of this._sprites) s.node.sprite.opacity = s.opacity\n    if (this._ignition) this._ignition.visible = false\n    if (this._shown) for (const l of this._lights) l.node.light.intensity = l.intensity\n  }\n}\n\n/** Smoothstep on 0..1. */\nfunction smooth(x: number): number {\n  const t = Math.min(1, Math.max(0, x))\n  return t * t * (3 - 2 * t)\n}\n",
    "scriptVars": {}
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
