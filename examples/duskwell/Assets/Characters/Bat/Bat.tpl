{
  "id": "966572914b7d932f46ee9e35e7037666",
  "name": "Bat",
  "nodeJson": {
    "id": "2d1e88c0feca94f37b807fbe78b7b659",
    "name": "Bat",
    "type": "characterBody2D",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "2d9279a97bbc2cea2d8e131ff3179c00",
        "name": "Sprite",
        "type": "animatedSprite",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "sprite": {
          "constraints": "free",
          "tilesetId": "29246ba8ba9c1d613f76dd94e570aabc",
          "tileset": {
            "id": "29246ba8ba9c1d613f76dd94e570aabc",
            "textureId": "bat.png",
            "imageWidth": 512,
            "imageHeight": 448,
            "tileWidth": 64,
            "tileHeight": 64,
            "margin": 0,
            "spacing": 0,
            "columns": 8,
            "rows": 7,
            "pixelsPerUnit": 16,
            "tiles": {},
            "terrains": [],
            "variantSets": []
          },
          "tileIndex": 0,
          "tint": [1, 1, 1],
          "opacity": 1,
          "transparent": true,
          "side": "double",
          "wireframe": false,
          "sortingOrder": 1,
          "pivot": [0.5, 0.35]
        },
        "animation": {
          "frames": [],
          "frameSource": "node",
          "fps": 10,
          "loop": true
        },
        "animationSet": {
          "id": "59ffcfc902805044e7cc4db87727751a",
          "name": "Bat",
          "defaultClip": "sleep",
          "clips": [
            {
              "name": "sleep",
              "fps": 4,
              "loop": "pingpong",
              "frames": [
                {
                  "tile": 0
                },
                {
                  "tile": 1
                },
                {
                  "tile": 2
                }
              ]
            },
            {
              "name": "wakeup",
              "fps": 16,
              "loop": "once",
              "frames": [
                {
                  "tile": 3
                },
                {
                  "tile": 4
                },
                {
                  "tile": 5
                },
                {
                  "tile": 6
                },
                {
                  "tile": 7
                },
                {
                  "tile": 8
                },
                {
                  "tile": 9
                },
                {
                  "tile": 10
                },
                {
                  "tile": 11
                },
                {
                  "tile": 12
                },
                {
                  "tile": 13
                },
                {
                  "tile": 14
                },
                {
                  "tile": 15
                },
                {
                  "tile": 16
                },
                {
                  "tile": 17
                },
                {
                  "tile": 18
                }
              ]
            },
            {
              "name": "fly",
              "fps": 12,
              "loop": "loop",
              "frames": [
                {
                  "tile": 19
                },
                {
                  "tile": 20
                },
                {
                  "tile": 21
                },
                {
                  "tile": 22
                },
                {
                  "tile": 23
                },
                {
                  "tile": 24
                },
                {
                  "tile": 25
                },
                {
                  "tile": 26
                },
                {
                  "tile": 27
                }
              ]
            },
            {
              "name": "attack",
              "fps": 14,
              "loop": "once",
              "frames": [
                {
                  "tile": 28
                },
                {
                  "tile": 29
                },
                {
                  "tile": 30
                },
                {
                  "tile": 31
                },
                {
                  "tile": 32
                },
                {
                  "tile": 33
                },
                {
                  "tile": 34
                },
                {
                  "tile": 35
                }
              ],
              "next": "fly"
            },
            {
              "name": "hurt",
              "fps": 14,
              "loop": "once",
              "frames": [
                {
                  "tile": 36
                },
                {
                  "tile": 37
                },
                {
                  "tile": 38
                },
                {
                  "tile": 39
                },
                {
                  "tile": 40
                }
              ],
              "next": "fly"
            },
            {
              "name": "die",
              "fps": 12,
              "loop": "once",
              "frames": [
                {
                  "tile": 41
                },
                {
                  "tile": 42
                },
                {
                  "tile": 43
                },
                {
                  "tile": 44
                },
                {
                  "tile": 45
                },
                {
                  "tile": 46
                },
                {
                  "tile": 47
                },
                {
                  "tile": 48
                },
                {
                  "tile": 49
                },
                {
                  "tile": 50
                },
                {
                  "tile": 51
                },
                {
                  "tile": 52
                }
              ]
            }
          ]
        }
      },
      {
        "id": "5669842a1d7d7541cf797de45aab9dd3",
        "name": "Bite",
        "type": "trigger",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "sensor": {
          "shapes": [],
          "size": [0.9, 0.8],
          "offset": [0, 0.5],
          "layer": 128,
          "mask": 16,
          "detectTriggers": false,
          "continuous": false,
          "enabled": true
        }
      },
      {
        "id": "266437b7ef766f4eacd5310990f8ae10",
        "name": "Bat Brain",
        "type": "controller",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "possessedId": "2d1e88c0feca94f37b807fbe78b7b659",
        "aimSourceId": null,
        "navMeshId": null,
        "controlSource": "ai",
        "moveAction": "Move",
        "lookAction": "Look",
        "jumpAction": "Jump",
        "sprintAction": "Sprint",
        "crouchAction": "",
        "aimSource": "world",
        "driveAimTarget": false,
        "goal": "idle",
        "targetKey": "target",
        "goalPoint": [0, 0, 0],
        "steering": {
          "maxSpeed": 3.2,
          "arriveRadius": 0.5,
          "slowRadius": 1.5,
          "standoff": 2,
          "wanderRadius": 1.2,
          "wanderDistance": 2.5,
          "wanderJitter": 90,
          "separationRadius": 1.5,
          "avoidDistance": 0,
          "avoidStrength": 1.5
        },
        "routeName": "",
        "flockRadius": 6,
        "separationWeight": 1.5,
        "alignmentWeight": 1,
        "cohesionWeight": 0.8,
        "perception": {
          "fieldOfView": 360,
          "range": 12,
          "memorySpan": 4,
          "reactionTime": 0.2
        },
        "eyeHeight": 0.5,
        "autoAcquire": true,
        "perceptionLayers": 16,
        "repath": {
          "interval": 0.5,
          "targetDrift": 1.5
        },
        "waypointRadius": 0.5,
        "whiskerCount": 3,
        "whiskerSpread": 60,
        "behavior": {
          "parameters": [
            {
              "name": "Dead",
              "type": "boolean",
              "default": false,
              "source": {
                "kind": "builtin",
                "name": "isDead"
              }
            },
            {
              "name": "Hurt",
              "type": "boolean",
              "default": false,
              "source": {
                "kind": "builtin",
                "name": "isHurt"
              }
            },
            {
              "name": "Awake",
              "type": "boolean",
              "default": false,
              "source": {
                "kind": "builtin",
                "name": "isAwake"
              }
            },
            {
              "name": "Swoop Ready",
              "type": "boolean",
              "default": false,
              "source": {
                "kind": "builtin",
                "name": "swoopReady"
              }
            },
            {
              "name": "Swooping",
              "type": "boolean",
              "default": false,
              "source": {
                "kind": "builtin",
                "name": "isSwooping"
              }
            },
            {
              "name": "From Home",
              "type": "number",
              "default": 0,
              "source": {
                "kind": "builtin",
                "name": "distanceFromHome"
              }
            },
            {
              "name": "In Sight",
              "type": "boolean",
              "default": false,
              "source": {
                "kind": "sense",
                "name": "targetInSight"
              }
            },
            {
              "name": "Has Target",
              "type": "boolean",
              "default": false,
              "source": {
                "kind": "sense",
                "name": "hasTarget"
              }
            },
            {
              "name": "Distance",
              "type": "number",
              "default": 99,
              "source": {
                "kind": "sense",
                "name": "distanceToTarget"
              }
            }
          ],
          "states": [
            {
              "name": "Sleep",
              "goal": "idle",
              "speedScale": 0,
              "isEntry": true,
              "x": 40,
              "y": 160
            },
            {
              "name": "Wake",
              "goal": "script",
              "speedScale": 0,
              "x": 240,
              "y": 160
            },
            {
              "name": "Chase",
              "goal": "path",
              "x": 440,
              "y": 160
            },
            {
              "name": "Swoop",
              "goal": "script",
              "x": 640,
              "y": 60
            },
            {
              "name": "Hurt",
              "goal": "script",
              "speedScale": 0,
              "x": 640,
              "y": 260
            },
            {
              "name": "Roost",
              "goal": "path",
              "targetKey": "point",
              "speedScale": 0.6,
              "x": 440,
              "y": 320
            },
            {
              "name": "Dead",
              "goal": "idle",
              "speedScale": 0,
              "x": 40,
              "y": 320
            }
          ],
          "transitions": [
            {
              "from": "*",
              "to": "Dead",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Dead",
                    "op": "true"
                  }
                ]
              }
            },
            {
              "from": "Chase",
              "to": "Hurt",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Hurt",
                    "op": "true"
                  }
                ]
              }
            },
            {
              "from": "Swoop",
              "to": "Hurt",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Hurt",
                    "op": "true"
                  }
                ]
              }
            },
            {
              "from": "Roost",
              "to": "Hurt",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Hurt",
                    "op": "true"
                  }
                ]
              }
            },
            {
              "from": "Hurt",
              "to": "Chase",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Hurt",
                    "op": "false"
                  }
                ]
              },
              "minDwell": 0.1
            },
            {
              "from": "Sleep",
              "to": "Wake",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "In Sight",
                    "op": "true"
                  }
                ]
              }
            },
            {
              "from": "Wake",
              "to": "Chase",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Awake",
                    "op": "true"
                  }
                ]
              }
            },
            {
              "from": "Chase",
              "to": "Swoop",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Distance",
                    "op": "lt",
                    "value": 3
                  },
                  {
                    "param": "Swoop Ready",
                    "op": "true"
                  }
                ]
              },
              "minDwell": 0.6
            },
            {
              "from": "Swoop",
              "to": "Chase",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Swooping",
                    "op": "false"
                  }
                ]
              },
              "minDwell": 0.2
            },
            {
              "from": "Chase",
              "to": "Roost",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "Has Target",
                    "op": "false"
                  }
                ]
              },
              "minDwell": 1
            },
            {
              "from": "Roost",
              "to": "Chase",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "In Sight",
                    "op": "true"
                  }
                ]
              }
            },
            {
              "from": "Roost",
              "to": "Sleep",
              "condition": {
                "op": "and",
                "children": [
                  {
                    "param": "From Home",
                    "op": "lt",
                    "value": 0.6
                  }
                ]
              }
            }
          ]
        },
        "brain": "machine",
        "brainId": "dee50a458417428157e05a3d50f12e0d"
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "9df85359807001e6fb6058c9112e9792",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "characterBody2D": {
      "size": [1.2, 1],
      "layer": 32,
      "movement": "fly",
      "walkSpeed": 3.2,
      "runSpeed": 3.2,
      "acceleration": 18,
      "deceleration": 100,
      "airControl": 0.7,
      "jumpHeight": 3.4,
      "jumpTimeToApex": 0.36,
      "fallGravityMultiplier": 1.7,
      "maxFallSpeed": 24,
      "coyoteSeconds": 0.1,
      "jumpBufferSeconds": 0.12,
      "stepHeight": 0.5,
      "flipSprites": false,
      "oneWayPlatforms": false
    },
    "script": "import { AnimatedSpriteNode, CharacterBody2DNode, ControllerNode, Node, TriggerNode } from 'cleo'\nimport { find, child, attribute, animAction, eventListener } from 'cleo/decorators'\n\n/**\n * Duskwell -- a bat. Attach to a flying Character Body 2D (no gravity, through one-way platforms) whose\n * children are `Sprite` (the bat's clips: sleep, wakeup, fly, attack, hurt, die), `Bite` (an Area 2D that\n * sees the player's layer: the player's script asks this node's `contactDamage`) and, last, its `Bat Brain`\n * AI Controller.\n *\n * The brain decides (the Bat Brain asset): asleep until it sees the player, it wakes, flies at the player\n * on the air grid -- round the pillar, not through it --, swoops when close, and flies home to roost when\n * it forgets the player. This script does what a goal cannot: waking, the swoop (a dash it owns in\n * onMove2D), the hurt and the death, and it publishes what the brain reads: `isAwake`, `swoopReady`,\n * `isSwooping`, `isHurt`, `isDead`, `distanceFromHome`.\n */\nexport default class DuskBat extends CharacterBody2DNode {\n  @attribute\n  public health: number = 3\n  @attribute\n  public contactDamage: number = 1\n  @attribute\n  public swoopSpeed: number = 7.5\n  /** Seconds between swoops. */\n  @attribute\n  public swoopCooldown: number = 1.2\n  @attribute\n  public knockback: number = 8\n  /** The bat's art faces left: its sprite is mirrored to face right. */\n  @attribute\n  public artFacesLeft: boolean = false\n\n  @child('Sprite')\n  private _sprite: AnimatedSpriteNode = null\n  @child('Bite')\n  private _bite: TriggerNode = null\n  private _brain: ControllerNode = null\n  @find('Player')\n  private _player: Node = null\n  private _home: [number, number] = [0, 0]\n  private _awake: boolean = false\n  private _waking: boolean = false\n  private _swoopLeft: number = 0\n  private _swoopDir: [number, number] = [1, 0]\n  private _cooldownLeft: number = 0\n  private _hurtLeft: number = 0\n  private _dead: boolean = false\n  private _deadLeft: number = 0\n  private _bob: number = 0\n\n  onStart() {\n    this._brain = this.children.find(c => c instanceof ControllerNode) as ControllerNode ?? null\n    this.movement = 'fly'\n    this.oneWayPlatforms = false\n    this.flipSprites = false\n    const p = this.position\n    // A flier steers by the middle of its box: home, for Roost's 'point', is there too.\n    this._home = [p[0], p[1] + this.size[1] * 0.5]\n    if (this._brain) this._brain.goalPoint = [this._home[0], this._home[1], 0]\n    this._bob = Math.random() * 6.28\n    this._clip('sleep')\n  }\n\n  /** Play `name` on the sprite from its start: `animator:PlayAction`, sent down to it. */\n  @animAction()\n  private _clip(name: string) {\n    return { clip: name, restart: true }\n  }\n\n  /** Awake once the wake-up has played out (the sprite says so with `animation:ClipFinished`): off it flies. */\n  @eventListener('animation:ClipFinished', { where: { clip: 'wakeup' } })\n  private _wokeUp() {\n    if (!this._waking || this._awake || this._dead) return\n    this._awake = true\n    this._clip('fly')\n  }\n\n  public get isDead(): boolean { return this._dead }\n  public get isHurt(): boolean { return this._hurtLeft > 0 }\n  public get isAwake(): boolean { return this._awake }\n  public get isSwooping(): boolean { return this._swoopLeft > 0 }\n  public get swoopReady(): boolean { return this._awake && this._swoopLeft <= 0 && this._cooldownLeft <= 0 && !this._dead }\n  public get distanceFromHome(): number {\n    return Math.hypot(this.position[0] - this._home[0], this.position[1] + this.size[1] * 0.5 - this._home[1])\n  }\n\n  onUpdate(delta: number) {\n    this._cooldownLeft = Math.max(0, this._cooldownLeft - delta)\n    this._hurtLeft = Math.max(0, this._hurtLeft - delta)\n    this._bob += delta * 5\n    if (this._dead) {\n      this._deadLeft -= delta\n      if (this._deadLeft <= 0) this.remove()\n      return\n    }\n    const state = this._brain?.behaviorState ?? ''\n    const s = this._sprite\n    if (state === 'Sleep') {\n      this._awake = false\n      this._waking = false\n      if (s && s.clip !== 'sleep') this._clip('sleep')\n    } else if (state === 'Wake') {\n      // The wake-up plays once; `_wokeUp` hears it finish.\n      if (!this._waking) { this._waking = true; this._clip('wakeup') }\n    } else if (state === 'Swoop') {\n      if (this.swoopReady) this._startSwoop()\n    } else if ((state === 'Chase' || state === 'Roost') && s && s.clip !== 'fly' && this._swoopLeft <= 0 && this._hurtLeft <= 0) {\n      this._clip('fly')\n    }\n    // A gentle bob, on the sprite alone so the body's path stays true.\n    if (s) s.setPosition([0, this._awake ? Math.sin(this._bob) * 0.12 : 0, 0])\n    // Face the way it flies, or the player.\n    const vx = this.velocity2D[0]\n    const p = this._player\n    const facingLeft = (Math.abs(vx) > 0.1 ? vx : p ? p.worldPosition[0] - this.worldPosition[0] : 1) < 0\n    if (s) s.flipX = this.artFacesLeft ? !facingLeft : facingLeft\n  }\n\n  private _startSwoop() {\n    const p = this._player\n    if (!p) return\n    const dx = p.worldPosition[0] - this.worldPosition[0]\n    const dy = p.worldPosition[1] + 1.2 - (this.worldPosition[1] + this.size[1] * 0.5)\n    const d = Math.hypot(dx, dy) || 1\n    this._swoopDir = [dx / d, dy / d]\n    this._swoopLeft = 0.55\n    this._cooldownLeft = this.swoopCooldown\n    this._clip('attack')\n  }\n\n  /**\n   * The swoop, the hurt and the death are the bat's own motion, every physics substep: a wind-up back, a\n   * lunge at the player; a knock-back easing off; a fall out of the air.\n   */\n  onMove2D(dt: number): boolean {\n    const v = this.velocity2D\n    if (this._dead) {\n      v[0] *= Math.pow(0.4, dt)\n      v[1] = Math.max(-14, v[1] - 30 * dt)\n      return true\n    }\n    if (this._hurtLeft > 0) {\n      const k = Math.pow(0.02, dt)\n      v[0] *= k; v[1] *= k\n      return true\n    }\n    if (this._swoopLeft > 0) {\n      const t = 0.55 - this._swoopLeft\n      this._swoopLeft = Math.max(0, this._swoopLeft - dt)\n      const speed = t < 0.15 ? -2 : this.swoopSpeed\n      v[0] = this._swoopDir[0] * speed\n      v[1] = this._swoopDir[1] * speed\n      return true\n    }\n    return false\n  }\n\n  onTriggerEnter(other: Node) {\n    if (other.name !== 'Sword' || this._dead) return\n    this.takeHit(1, other)\n  }\n\n  public takeHit(damage: number, from: Node | null) {\n    if (this._dead) return\n    this.health -= damage\n    const away = from ? Math.sign(this.worldPosition[0] - from.worldPosition[0]) || 1 : 1\n    this.velocity2D[0] = away * this.knockback\n    this.velocity2D[1] = 3\n    this._swoopLeft = 0\n    this._awake = true\n    const cam = this.findNode('Camera') as any\n    cam?.shake?.(0.12, 0.15)\n    if (this.health <= 0) {\n      this._dead = true\n      if (this._bite) this._bite.enabled = false\n      this._deadLeft = 1.4\n      this._clip('die')\n      ;(this._player as any)?.collect?.('diamond', 1)\n      return\n    }\n    this._hurtLeft = 0.35\n    this._clip('hurt')\n  }\n}\n",
    "scriptVars": {}
  },
  "scripts": {},
  "textureIds": []
}
