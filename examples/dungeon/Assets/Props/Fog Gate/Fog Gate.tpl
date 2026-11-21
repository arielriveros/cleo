{
  "id": "1a54cedcc64cc5dd69cb57bc156f363d",
  "name": "Fog Gate",
  "nodeJson": {
    "id": "12461c3267786670d6787bd592c1c7d8",
    "name": "Fog Gate",
    "type": "collider",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "6d76b05779f80cbb81b5728d11084abc",
        "name": "FogWall",
        "type": "model",
        "position": [0, 2, 0],
        "rotation": [0, 0, 0],
        "scale": [5.9, 4, 0.08],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "f252ef5aaf99284e68bc54a5b8b91356",
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
            "baseColor": [0.95, 0.95, 1],
            "metallic": 0,
            "roughness": 0.85,
            "opacity": 0.28,
            "emissiveFactor": [0.6, 0.62, 0.7],
            "emissiveIntensity": 0.6,
            "emissiveExposureWeight": 0.1,
            "textures": {},
            "config": {
              "side": "front",
              "wireframe": false,
              "transparent": true,
              "castShadow": false,
              "probeable": true
            }
          }
        }
      },
      {
        "id": "7be2ccfa8af5ca34158690e5d3b3649d",
        "name": "Fog",
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
                "id": "e87f4bd7e2042bff3275ff4ba71be683",
                "name": "Fog",
                "enabled": true,
                "capacity": 1024,
                "simSpace": "world",
                "duration": 5,
                "looping": true,
                "prewarm": true,
                "startDelay": 0,
                "seed": 13389691,
                "maxLod": 99,
                "spawn": [
                  {
                    "type": "spawnRate",
                    "enabled": true,
                    "params": {
                      "rate": 90,
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
                      "shape": "box",
                      "radius": 0.25,
                      "thickness": 1,
                      "arc": 360,
                      "angle": 20,
                      "box": [5.6, 3.6, 0.3],
                      "offset": [0, 1.8, 0],
                      "orbit": 0
                    }
                  },
                  {
                    "type": "lifetime",
                    "enabled": true,
                    "params": {
                      "range": [2, 3.2]
                    }
                  },
                  {
                    "type": "velocity",
                    "enabled": true,
                    "params": {
                      "mode": "direction",
                      "direction": [0, 1, 0],
                      "spread": 60,
                      "speed": [0.05, 0.3],
                      "inherit": 0
                    }
                  },
                  {
                    "type": "size",
                    "enabled": true,
                    "params": {
                      "range": [0.9, 1.6]
                    }
                  },
                  {
                    "type": "rotation",
                    "enabled": true,
                    "params": {
                      "angle": [0, 360],
                      "spin": [-15, 15]
                    }
                  },
                  {
                    "type": "color",
                    "enabled": true,
                    "params": {
                      "mode": "constant",
                      "colorA": [0.92, 0.94, 1, 0.22],
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
                      "intensity": 1.2
                    }
                  }
                ],
                "update": [
                  {
                    "type": "curlNoise",
                    "enabled": true,
                    "params": {
                      "strength": 0.4,
                      "frequency": 0.6,
                      "scroll": 0.2,
                      "octaves": 1
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
                            "a": 0.9
                          },
                          {
                            "t": 0.7,
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
                  "alignment": "camera",
                  "blend": "alpha",
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
                  "softness": 0.8,
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
              "center": [0, 1.8, 0],
              "extents": [3.5, 2.5, 1]
            },
            "lod": {
              "enabled": true,
              "levels": [],
              "cullDistance": 0,
              "scaleBursts": false
            }
          },
          "particleSystemId": "789571957bc2052a85aa4ffe639f8f8b",
          "playOnStart": true,
          "simulationSpeed": 1,
          "spawnRateScale": 1,
          "tint": [1, 1, 1, 1]
        }
      },
      {
        "id": "27b2a1c07a8df2a441abe595105173f5",
        "name": "Sounds",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [
          {
            "id": "e8fab88b524948e56a0ce38cfd399577",
            "name": "Fog",
            "type": "sound",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {},
            "spawnOnStart": true,
            "sound": {
              "mode": "spatial",
              "sampleId": null,
              "volume": 1,
              "loopMode": "inherit",
              "playOnStart": false,
              "distanceModel": "inverse",
              "refDistance": 2,
              "maxDistance": 40,
              "rolloffFactor": 1
            }
          }
        ],
        "variables": {},
        "spawnOnStart": true
      },
      {
        "type": "trigger",
        "name": "Fog Gate Trigger",
        "id": "12461c3267786670d6787bd592c1c7d8:trigger",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "sensor": {
          "shapes": [
            {
              "type": "box",
              "width": 6,
              "height": 3,
              "depth": 4.4,
              "offset": [0, 1.5, 0],
              "rotation": [0, 0, 0]
            }
          ],
          "layer": 1,
          "mask": -1,
          "detectTriggers": false,
          "continuous": false,
          "enabled": true
        }
      }
    ],
    "variables": {
      "navObstacle": {
        "type": "boolean",
        "value": false,
        "access": "public"
      },
      "__scriptId": {
        "type": "string",
        "value": "1e7f37dffa09572f39dce4bd5f00495d",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { save, find, child, attribute } from 'cleo/decorators'\nimport { playSound } from '@/Core/Scripts/SoulsAudio'\n\n/**\n * Hollow Keep — the fog wall in front of the boss. Attach to a node at the arena's mouth that carries a\n * STATIC box body (the blocker), with its local +Z pointing INTO the arena.\n *\n *   Fog Gate          this script + box body\n *   ├── FogWall       the translucent sheet — any mesh\n *   └── Fog           particle system, the drifting fog\n *\n *   closed    blocks both ways. From OUTSIDE, Interact: \"Traverse the white fog\". The player is lined\n *             up, walks through over `walkSeconds` with i-frames while the body is a ghost, and the\n *             fight starts on the far side.\n *   fight     blocks both ways, no prompt — there is no leaving.\n *   gone      the boss is dead: the fog dissolves for good.\n *\n * A death mid-fight resets it to `closed` (the manager calls `resetGate`). A save keeps `gateState`, so a\n * game loaded after the boss fell finds the way open.\n *\n * The prompt comes from the gate's TRIGGER volume (a box spanning both sides of the wall): standing in it\n * offers \"Traverse\", and `canInteract` only allows it from outside. A separate `Boss Arena` zone (a\n * trigger with the `isBossArena` variable) starts the fight if the player ever gets inside without\n * walking through.\n */\nexport default class SoulsFogGateNode extends Node {\n  /** Metres in front of the gate (outside) the player is lined up at before walking. */\n  @attribute\n  public entryDistance: number = 1.1\n  @attribute\n  public walkDistance: number = 2.8\n  @attribute\n  public walkSeconds: number = 1.5\n  @attribute\n  public isFogGate: boolean = true\n  /** 'closed' | 'fight' | 'gone' */\n  @save\n  @attribute\n  public gateState: string = 'closed'\n\n  @find('GameManager')\n  private _gm: Node = null\n  @child('Fog')\n  private _fog?: Node\n  @child('FogWall')\n  private _wall?: Node\n  private _fade: number = -1\n\n  onStart() {\n    // A loaded game: the fog the boss's death dissolved stays gone; a fight is never resumed mid-way.\n    if (this.gateState === 'fight') this.gateState = 'closed'\n    if (this.gateState === 'gone') {\n      this._solid(false)\n      ;(this._fog as any)?.stop?.()\n      if (this._wall) this._wall.visible = false\n    } else this._solid(true)\n    ;(this._gm as any)?.registerInteractable?.(this)\n  }\n\n  onDespawn() {\n    ;(this._gm as any)?.unregisterInteractable?.(this)\n  }\n\n  public canInteract(player: Node): boolean {\n    if (this.gateState !== 'closed' || !player) return false\n    return this._side(player.worldPosition) < 0\n  }\n\n  public promptText(player: Node): string { return 'Traverse the white fog' }\n\n  public interact(player: Node): void {\n    const p = player as any\n    if (!p.walkThroughFog) return\n    const me = this.worldPosition\n    const f = this._forward()\n    const start = [me[0] - f[0] * this.entryDistance, player.worldPosition[1], me[2] - f[2] * this.entryDistance]\n    const yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI\n    this._solid(false)\n    p.walkThroughFog(start, yaw, this.walkDistance, this.walkSeconds)\n    playSound(this, 'Fog')\n    this.after(this.walkSeconds + 0.05, () => {\n      this._solid(true)\n      this.gateState = 'fight'\n      ;(this._gm as any)?.startBossFight?.(this)\n    })\n  }\n\n  /** The boss died: fade the fog out and leave the way open. */\n  public dissolve(): void {\n    this.gateState = 'gone'\n    this._solid(false)\n    ;(this._fog as any)?.stop?.()\n    this._fade = 0\n  }\n\n  /** The player died mid-fight. */\n  public resetGate(): void {\n    if (this.gateState === 'gone') return\n    this.gateState = 'closed'\n    this._solid(true)\n  }\n\n  onUpdate(delta: number) {\n    if (this._fade < 0) return\n    this._fade += delta\n    const wall = this._wall as any\n    if (wall && this._fade > 1.2 && wall.visible) wall.visible = false\n    if (this._fade > 1.2) this._fade = -1\n  }\n\n  /** Signed distance of a point along the gate's forward: negative outside, positive inside. */\n  private _side(point: ArrayLike<number>): number {\n    const me = this.worldPosition\n    const f = this._forward()\n    return (point[0] - me[0]) * f[0] + (point[2] - me[2]) * f[2]\n  }\n\n  private _forward(): number[] {\n    const f = this.worldForward\n    const len = Math.hypot(f[0], f[2]) || 1\n    return [f[0] / len, 0, f[2] / len]\n  }\n\n  private _solid(on: boolean): void {\n    const body = this.body as any\n    if (body) body.simulatePhysics = on\n  }\n}\n",
    "scriptVars": {},
    "collider": {
      "mass": 0,
      "linearDamping": 0,
      "angularDamping": 0,
      "linearConstraints": [1, 1, 1],
      "angularConstraints": [1, 1, 1],
      "friction": 0.3,
      "restitution": 0,
      "simulatePhysics": true,
      "groundProbeDistance": 0,
      "motionSmoothing": 0,
      "shapes": [
        {
          "type": "box",
          "width": 6,
          "height": 4,
          "depth": 0.5,
          "offset": [0, 2, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "layer": 1
    }
  },
  "textureIds": [],
  "scripts": {}
}
