{
  "id": "07c304d8723086215227b039254b5a49",
  "name": "Greatsword",
  "nodeJson": {
    "id": "8c805a2cec27cc33e36ae4ea40aae181",
    "name": "Greatsword",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "3e3181b13bc377d67f2b13331d9d9498",
        "name": "Mesh",
        "type": "node",
        "position": [0.0139, 0.0708, -0.0315],
        "rotation": [-175.553, 7.685, 113.999],
        "scale": [1, 1, 1],
        "children": [
          {
            "name": "War Hammer",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "ac821019d78f456633ac95a14281ac00",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "2812c8a81fb9c12b3aa305ca6c602acabb1ed1c490a70aaab1d13c41a051df97",
                    "l": 43800
                  },
                  "normals": {
                    "h": "56bc7a405812db295dbf27b04318c04ec8b9120da53a1c8aa39398c690728e1c",
                    "l": 43800
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "371b337da71e479413704a8d7c0fe057e66e6a116333b133aa61373df3a73973",
                    "l": 29200
                  },
                  "indices": {
                    "h": "c8a4192d643388ce2d177a48da0872f8cd18c769d13ccc4a31fd53236c3fa8cc",
                    "l": 31152,
                    "bits": 16
                  },
                  "typed": true
                }
              },
              "material": {
                "type": "pbr",
                "baseColor": [1, 1, 1],
                "metallic": 1,
                "roughness": 1,
                "opacity": 1,
                "emissiveFactor": [0, 0, 0],
                "emissiveIntensity": 1,
                "textures": {
                  "baseColorTexture": "06ff80cd8794fe262b6a49bf2e18b74f",
                  "metallicRoughnessTexture": "f39a56c278e0a2fd4e9849ad377d50fa",
                  "occlusionMap": "f39a56c278e0a2fd4e9849ad377d50fa",
                  "normalMap": "c20433c7c412b6286ac838ac876bfa8c"
                },
                "config": {
                  "side": "double",
                  "wireframe": false,
                  "transparent": false,
                  "castShadow": true,
                  "probeable": true
                }
              }
            },
            "animationMappings": null,
            "stateMachine": null,
            "ragdoll": null,
            "id": "7de2f49ef7d84237cc4166e47e96e12d"
          }
        ],
        "variables": {},
        "spawnOnStart": true
      },
      {
        "name": "Light1",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {
          "__scriptId": {
            "type": "string",
            "value": "f01e760bd99206e45f8f6bf1a100f851",
            "access": "public"
          }
        },
        "spawnOnStart": true,
        "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport type { NodeName, TriggerName } from 'cleo'\n\n/**\n * Hollow Keep — one attack of a weapon's moveset. Attach to a plain child node of a SoulsWeapon; the\n * node's NAME is what the weapon's `lightMove`/`heavyMove` and other moves' `next` refer to.\n *\n * ## Timing\n *\n * Three moments drive an attack, and they come from EVENT MARKERS on the clip when it has them:\n *\n   *   hit       the blade becomes ACTIVE: from here until `hitEnd` it is swept every frame and damages\n *             each enemy hurtbox it touches, once per swing (SoulsHitbox)\n *   hitEnd    the blade stops being active\n *   combo     from here a buffered attack chains into `next`\n *   recover   from here a buffered roll or drink may cancel the rest of the swing\n *\n * Author them on the clip's timeline in the Animation editor. A clip with no `hit` event uses the\n * `hitTime`/`comboTime`/`recoverTime` fields below instead (CLIP seconds from the move's start, i.e.\n * before its state's speed), so a freshly imported animation is playable straight away and only gets\n * better once marked up.\n *\n * ## Animation\n *\n * `animTrigger` names the animator trigger that plays the move: the player's animator has a state entered by\n * it, whose clip, speed, start in the clip and blends are the move's animation. A state that extracts its\n * root travel moves the body by the clip's own hips (an attack whose feet step goes exactly as far as they\n * do); otherwise the `lunge*` drive below does.\n *\n * ## One clip, several attacks\n *\n * A combo can be ONE continuous animation: each move's state plays a segment of it (its start time), and\n * hands over to the next move's state at the segment's end, on that move's trigger. A chained attack\n * restarts nothing -- the animation plays on into it. A segment that is not chained blends out.\n */\nexport default class SoulsMoveNode extends Node {\n  /** The animator trigger that plays this move, e.g. \"Longsword Light1\". Empty: the node's name. */\n  @attribute\n  public animTrigger: TriggerName = ''\n  /** Multipliers on the weapon's attack rating and poise damage. */\n  @attribute\n  public damageMul: number = 1\n  @attribute\n  public poiseMul: number = 1\n  @attribute\n  public staminaCost: number = 16\n  /**\n   * The swing bounces off walls (`blocksSwings` bodies) it reaches before any enemy: sparks, a recoil, no\n   * damage. Heavy slams turn it off and plough through.\n   */\n  @attribute\n  public bounceOff: boolean = true\n  /** Forward drive: from `lungeStart` (clip seconds) for `lungeSeconds`, at `lungeSpeed` m/s. */\n  @attribute\n  public lungeStart: number = 0.1\n  @attribute\n  public lungeSeconds: number = 0.15\n  @attribute\n  public lungeSpeed: number = 2.5\n  /** Seconds after the swing starts during which the player can still turn toward the target. */\n  @attribute\n  public trackSeconds: number = 0.2\n  /** Fallback timings, used only when the clip carries no `hit` event. Clip seconds. */\n  @attribute\n  public hitTime: number = 0.38\n  @attribute\n  public activeSeconds: number = 0.15\n  @attribute\n  public comboTime: number = 0.45\n  @attribute\n  public recoverTime: number = 0.62\n  /** Name of the move a buffered light attack chains into. Empty restarts the chain. */\n  @attribute\n  public next: NodeName = 'Light2'\n  @attribute\n  public isMove: boolean = true\n}\n",
        "scriptVars": {
          "damageMul": 1,
          "staminaCost": 26,
          "lungeStart": 0.703,
          "lungeSeconds": 0.2,
          "lungeSpeed": 2,
          "trackSeconds": 0.715,
          "hitTime": 0.953,
          "comboTime": 1.233,
          "recoverTime": 1.553,
          "next": "Light2",
          "animTrigger": "Greatsword Light1",
          "activeSeconds": 0.2
        },
        "id": "4b2b8813cebac164a8d2ce0d7917e14e"
      },
      {
        "name": "Light2",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {
          "__scriptId": {
            "type": "string",
            "value": "f01e760bd99206e45f8f6bf1a100f851",
            "access": "public"
          }
        },
        "spawnOnStart": true,
        "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport type { NodeName, TriggerName } from 'cleo'\n\n/**\n * Hollow Keep — one attack of a weapon's moveset. Attach to a plain child node of a SoulsWeapon; the\n * node's NAME is what the weapon's `lightMove`/`heavyMove` and other moves' `next` refer to.\n *\n * ## Timing\n *\n * Three moments drive an attack, and they come from EVENT MARKERS on the clip when it has them:\n *\n   *   hit       the blade becomes ACTIVE: from here until `hitEnd` it is swept every frame and damages\n *             each enemy hurtbox it touches, once per swing (SoulsHitbox)\n *   hitEnd    the blade stops being active\n *   combo     from here a buffered attack chains into `next`\n *   recover   from here a buffered roll or drink may cancel the rest of the swing\n *\n * Author them on the clip's timeline in the Animation editor. A clip with no `hit` event uses the\n * `hitTime`/`comboTime`/`recoverTime` fields below instead (CLIP seconds from the move's start, i.e.\n * before its state's speed), so a freshly imported animation is playable straight away and only gets\n * better once marked up.\n *\n * ## Animation\n *\n * `animTrigger` names the animator trigger that plays the move: the player's animator has a state entered by\n * it, whose clip, speed, start in the clip and blends are the move's animation. A state that extracts its\n * root travel moves the body by the clip's own hips (an attack whose feet step goes exactly as far as they\n * do); otherwise the `lunge*` drive below does.\n *\n * ## One clip, several attacks\n *\n * A combo can be ONE continuous animation: each move's state plays a segment of it (its start time), and\n * hands over to the next move's state at the segment's end, on that move's trigger. A chained attack\n * restarts nothing -- the animation plays on into it. A segment that is not chained blends out.\n */\nexport default class SoulsMoveNode extends Node {\n  /** The animator trigger that plays this move, e.g. \"Longsword Light1\". Empty: the node's name. */\n  @attribute\n  public animTrigger: TriggerName = ''\n  /** Multipliers on the weapon's attack rating and poise damage. */\n  @attribute\n  public damageMul: number = 1\n  @attribute\n  public poiseMul: number = 1\n  @attribute\n  public staminaCost: number = 16\n  /**\n   * The swing bounces off walls (`blocksSwings` bodies) it reaches before any enemy: sparks, a recoil, no\n   * damage. Heavy slams turn it off and plough through.\n   */\n  @attribute\n  public bounceOff: boolean = true\n  /** Forward drive: from `lungeStart` (clip seconds) for `lungeSeconds`, at `lungeSpeed` m/s. */\n  @attribute\n  public lungeStart: number = 0.1\n  @attribute\n  public lungeSeconds: number = 0.15\n  @attribute\n  public lungeSpeed: number = 2.5\n  /** Seconds after the swing starts during which the player can still turn toward the target. */\n  @attribute\n  public trackSeconds: number = 0.2\n  /** Fallback timings, used only when the clip carries no `hit` event. Clip seconds. */\n  @attribute\n  public hitTime: number = 0.38\n  @attribute\n  public activeSeconds: number = 0.15\n  @attribute\n  public comboTime: number = 0.45\n  @attribute\n  public recoverTime: number = 0.62\n  /** Name of the move a buffered light attack chains into. Empty restarts the chain. */\n  @attribute\n  public next: NodeName = 'Light2'\n  @attribute\n  public isMove: boolean = true\n}\n",
        "scriptVars": {
          "damageMul": 1.05,
          "staminaCost": 26,
          "lungeStart": 0.72,
          "lungeSeconds": 0.2,
          "lungeSpeed": 2,
          "trackSeconds": 0.728,
          "hitTime": 0.97,
          "comboTime": 1.25,
          "recoverTime": 1.57,
          "next": "Light1",
          "animTrigger": "Greatsword Light2",
          "activeSeconds": 0.2
        },
        "id": "4c2b89a6d1bac61da5d2c9547817dfbb"
      },
      {
        "name": "Heavy",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {
          "__scriptId": {
            "type": "string",
            "value": "f01e760bd99206e45f8f6bf1a100f851",
            "access": "public"
          }
        },
        "spawnOnStart": true,
        "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport type { NodeName, TriggerName } from 'cleo'\n\n/**\n * Hollow Keep — one attack of a weapon's moveset. Attach to a plain child node of a SoulsWeapon; the\n * node's NAME is what the weapon's `lightMove`/`heavyMove` and other moves' `next` refer to.\n *\n * ## Timing\n *\n * Three moments drive an attack, and they come from EVENT MARKERS on the clip when it has them:\n *\n   *   hit       the blade becomes ACTIVE: from here until `hitEnd` it is swept every frame and damages\n *             each enemy hurtbox it touches, once per swing (SoulsHitbox)\n *   hitEnd    the blade stops being active\n *   combo     from here a buffered attack chains into `next`\n *   recover   from here a buffered roll or drink may cancel the rest of the swing\n *\n * Author them on the clip's timeline in the Animation editor. A clip with no `hit` event uses the\n * `hitTime`/`comboTime`/`recoverTime` fields below instead (CLIP seconds from the move's start, i.e.\n * before its state's speed), so a freshly imported animation is playable straight away and only gets\n * better once marked up.\n *\n * ## Animation\n *\n * `animTrigger` names the animator trigger that plays the move: the player's animator has a state entered by\n * it, whose clip, speed, start in the clip and blends are the move's animation. A state that extracts its\n * root travel moves the body by the clip's own hips (an attack whose feet step goes exactly as far as they\n * do); otherwise the `lunge*` drive below does.\n *\n * ## One clip, several attacks\n *\n * A combo can be ONE continuous animation: each move's state plays a segment of it (its start time), and\n * hands over to the next move's state at the segment's end, on that move's trigger. A chained attack\n * restarts nothing -- the animation plays on into it. A segment that is not chained blends out.\n */\nexport default class SoulsMoveNode extends Node {\n  /** The animator trigger that plays this move, e.g. \"Longsword Light1\". Empty: the node's name. */\n  @attribute\n  public animTrigger: TriggerName = ''\n  /** Multipliers on the weapon's attack rating and poise damage. */\n  @attribute\n  public damageMul: number = 1\n  @attribute\n  public poiseMul: number = 1\n  @attribute\n  public staminaCost: number = 16\n  /**\n   * The swing bounces off walls (`blocksSwings` bodies) it reaches before any enemy: sparks, a recoil, no\n   * damage. Heavy slams turn it off and plough through.\n   */\n  @attribute\n  public bounceOff: boolean = true\n  /** Forward drive: from `lungeStart` (clip seconds) for `lungeSeconds`, at `lungeSpeed` m/s. */\n  @attribute\n  public lungeStart: number = 0.1\n  @attribute\n  public lungeSeconds: number = 0.15\n  @attribute\n  public lungeSpeed: number = 2.5\n  /** Seconds after the swing starts during which the player can still turn toward the target. */\n  @attribute\n  public trackSeconds: number = 0.2\n  /** Fallback timings, used only when the clip carries no `hit` event. Clip seconds. */\n  @attribute\n  public hitTime: number = 0.38\n  @attribute\n  public activeSeconds: number = 0.15\n  @attribute\n  public comboTime: number = 0.45\n  @attribute\n  public recoverTime: number = 0.62\n  /** Name of the move a buffered light attack chains into. Empty restarts the chain. */\n  @attribute\n  public next: NodeName = 'Light2'\n  @attribute\n  public isMove: boolean = true\n}\n",
        "scriptVars": {
          "bounceOff": false,
          "damageMul": 1.7,
          "poiseMul": 2,
          "staminaCost": 42,
          "lungeStart": 0.503,
          "lungeSeconds": 0.2,
          "lungeSpeed": 3,
          "trackSeconds": 0.565,
          "hitTime": 0.753,
          "comboTime": 1.033,
          "recoverTime": 1.353,
          "next": "",
          "animTrigger": "Greatsword Heavy",
          "activeSeconds": 0.2
        },
        "id": "4ec1ef33d171f3fee35df8b95638cd34"
      },
      {
        "id": "b3debd00275c3353a46409d63fcee371",
        "name": "Sounds",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [
          {
            "id": "4285d4f25a6272e9fc9c70fc6c5d12fb",
            "name": "Hit",
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
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "ddabe75cecac8d2ef380fece69dd25b8",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "socketAttachment": {
      "target": "parent",
      "socket": "RightHand"
    },
    "script": "import { attribute } from 'cleo/decorators'\nimport type { Vec3 } from 'cleo'\nimport SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'\n\n/**\n * Hollow Keep — the Greatsword: slow, heavy, strength-hungry, and it breaks poise. The player's second\n * weapon and the Elite Knight's only one: both spawn the same \"Greatsword\" template.\n */\nexport default class SoulsGreatswordNode extends SoulsWeaponNode {\n  @attribute\n  public displayName: string = 'Greatsword'\n  @attribute\n  public baseDamage: number = 165\n  @attribute\n  public strScaling: number = 1\n  @attribute\n  public dexScaling: number = 0.15\n  @attribute\n  public strRequirement: number = 16\n  @attribute\n  public dexRequirement: number = 0\n  @attribute\n  public poiseDamage: number = 32\n  @attribute\n  public bladeStart: Vec3 = [0, 0.17, 0]\n  @attribute\n  public bladeEnd: Vec3 = [0, 1.52, 0]\n  @attribute\n  public bladeRadius: number = 0.15\n}\n",
    "scriptVars": {
      "bladeStart": [0, 0.252, 0],
      "bladeEnd": [0, 1.01, 0],
      "bladeRadius": 0.13
    }
  },
  "scripts": {},
  "bodies": {},
  "triggers": {},
  "textureIds": [
    "06ff80cd8794fe262b6a49bf2e18b74f",
    "f39a56c278e0a2fd4e9849ad377d50fa",
    "c20433c7c412b6286ac838ac876bfa8c"
  ],
  "variant": {
    "baseTemplateId": "20a2e2bd4133caf56852609a6033758d",
    "diff": {
      "version": 1,
      "nodes": {
        "": {
          "merge": {
            "name": "Greatsword",
            "variables": {
              "__scriptId": {
                "value": "ddabe75cecac8d2ef380fece69dd25b8"
              }
            },
            "script": "import { attribute } from 'cleo/decorators'\nimport type { Vec3 } from 'cleo'\nimport SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'\n\n/**\n * Hollow Keep — the Greatsword: slow, heavy, strength-hungry, and it breaks poise. The player's second\n * weapon and the Elite Knight's only one: both spawn the same \"Greatsword\" template.\n */\nexport default class SoulsGreatswordNode extends SoulsWeaponNode {\n  @attribute\n  public displayName: string = 'Greatsword'\n  @attribute\n  public baseDamage: number = 165\n  @attribute\n  public strScaling: number = 1\n  @attribute\n  public dexScaling: number = 0.15\n  @attribute\n  public strRequirement: number = 16\n  @attribute\n  public dexRequirement: number = 0\n  @attribute\n  public poiseDamage: number = 32\n  @attribute\n  public bladeStart: Vec3 = [0, 0.17, 0]\n  @attribute\n  public bladeEnd: Vec3 = [0, 1.52, 0]\n  @attribute\n  public bladeRadius: number = 0.15\n}\n",
            "scriptVars": {
              "bladeStart": [0, 0.252, 0],
              "bladeEnd": [0, 1.01, 0],
              "bladeRadius": 0.13
            }
          }
        },
        "Mesh": {
          "merge": {
            "position": [0.0139, 0.0708, -0.0315],
            "rotation": [-175.553, 7.685, 113.999]
          }
        }
      },
      "added": [
        {
          "parent": "Mesh",
          "index": 0,
          "node": {
            "name": "War Hammer",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "ac821019d78f456633ac95a14281ac00",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "2812c8a81fb9c12b3aa305ca6c602acabb1ed1c490a70aaab1d13c41a051df97",
                    "l": 43800
                  },
                  "normals": {
                    "h": "56bc7a405812db295dbf27b04318c04ec8b9120da53a1c8aa39398c690728e1c",
                    "l": 43800
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "371b337da71e479413704a8d7c0fe057e66e6a116333b133aa61373df3a73973",
                    "l": 29200
                  },
                  "indices": {
                    "h": "c8a4192d643388ce2d177a48da0872f8cd18c769d13ccc4a31fd53236c3fa8cc",
                    "l": 31152,
                    "bits": 16
                  },
                  "typed": true
                }
              },
              "material": {
                "type": "pbr",
                "baseColor": [1, 1, 1],
                "metallic": 1,
                "roughness": 1,
                "opacity": 1,
                "emissiveFactor": [0, 0, 0],
                "emissiveIntensity": 1,
                "textures": {
                  "baseColorTexture": "06ff80cd8794fe262b6a49bf2e18b74f",
                  "metallicRoughnessTexture": "f39a56c278e0a2fd4e9849ad377d50fa",
                  "occlusionMap": "f39a56c278e0a2fd4e9849ad377d50fa",
                  "normalMap": "c20433c7c412b6286ac838ac876bfa8c"
                },
                "config": {
                  "side": "double",
                  "wireframe": false,
                  "transparent": false,
                  "castShadow": true,
                  "probeable": true
                }
              }
            },
            "animationMappings": null,
            "stateMachine": null,
            "ragdoll": null
          }
        },
        {
          "parent": "",
          "index": 1,
          "node": {
            "name": "Light1",
            "type": "node",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "f01e760bd99206e45f8f6bf1a100f851",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport type { NodeName, TriggerName } from 'cleo'\n\n/**\n * Hollow Keep — one attack of a weapon's moveset. Attach to a plain child node of a SoulsWeapon; the\n * node's NAME is what the weapon's `lightMove`/`heavyMove` and other moves' `next` refer to.\n *\n * ## Timing\n *\n * Three moments drive an attack, and they come from EVENT MARKERS on the clip when it has them:\n *\n   *   hit       the blade becomes ACTIVE: from here until `hitEnd` it is swept every frame and damages\n *             each enemy hurtbox it touches, once per swing (SoulsHitbox)\n *   hitEnd    the blade stops being active\n *   combo     from here a buffered attack chains into `next`\n *   recover   from here a buffered roll or drink may cancel the rest of the swing\n *\n * Author them on the clip's timeline in the Animation editor. A clip with no `hit` event uses the\n * `hitTime`/`comboTime`/`recoverTime` fields below instead (CLIP seconds from the move's start, i.e.\n * before its state's speed), so a freshly imported animation is playable straight away and only gets\n * better once marked up.\n *\n * ## Animation\n *\n * `animTrigger` names the animator trigger that plays the move: the player's animator has a state entered by\n * it, whose clip, speed, start in the clip and blends are the move's animation. A state that extracts its\n * root travel moves the body by the clip's own hips (an attack whose feet step goes exactly as far as they\n * do); otherwise the `lunge*` drive below does.\n *\n * ## One clip, several attacks\n *\n * A combo can be ONE continuous animation: each move's state plays a segment of it (its start time), and\n * hands over to the next move's state at the segment's end, on that move's trigger. A chained attack\n * restarts nothing -- the animation plays on into it. A segment that is not chained blends out.\n */\nexport default class SoulsMoveNode extends Node {\n  /** The animator trigger that plays this move, e.g. \"Longsword Light1\". Empty: the node's name. */\n  @attribute\n  public animTrigger: TriggerName = ''\n  /** Multipliers on the weapon's attack rating and poise damage. */\n  @attribute\n  public damageMul: number = 1\n  @attribute\n  public poiseMul: number = 1\n  @attribute\n  public staminaCost: number = 16\n  /**\n   * The swing bounces off walls (`blocksSwings` bodies) it reaches before any enemy: sparks, a recoil, no\n   * damage. Heavy slams turn it off and plough through.\n   */\n  @attribute\n  public bounceOff: boolean = true\n  /** Forward drive: from `lungeStart` (clip seconds) for `lungeSeconds`, at `lungeSpeed` m/s. */\n  @attribute\n  public lungeStart: number = 0.1\n  @attribute\n  public lungeSeconds: number = 0.15\n  @attribute\n  public lungeSpeed: number = 2.5\n  /** Seconds after the swing starts during which the player can still turn toward the target. */\n  @attribute\n  public trackSeconds: number = 0.2\n  /** Fallback timings, used only when the clip carries no `hit` event. Clip seconds. */\n  @attribute\n  public hitTime: number = 0.38\n  @attribute\n  public activeSeconds: number = 0.15\n  @attribute\n  public comboTime: number = 0.45\n  @attribute\n  public recoverTime: number = 0.62\n  /** Name of the move a buffered light attack chains into. Empty restarts the chain. */\n  @attribute\n  public next: NodeName = 'Light2'\n  @attribute\n  public isMove: boolean = true\n}\n",
            "scriptVars": {
              "damageMul": 1,
              "staminaCost": 26,
              "lungeStart": 0.703,
              "lungeSeconds": 0.2,
              "lungeSpeed": 2,
              "trackSeconds": 0.715,
              "hitTime": 0.953,
              "comboTime": 1.233,
              "recoverTime": 1.553,
              "next": "Light2",
              "animTrigger": "Greatsword Light1",
              "activeSeconds": 0.2
            }
          }
        },
        {
          "parent": "",
          "index": 2,
          "node": {
            "name": "Light2",
            "type": "node",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "f01e760bd99206e45f8f6bf1a100f851",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport type { NodeName, TriggerName } from 'cleo'\n\n/**\n * Hollow Keep — one attack of a weapon's moveset. Attach to a plain child node of a SoulsWeapon; the\n * node's NAME is what the weapon's `lightMove`/`heavyMove` and other moves' `next` refer to.\n *\n * ## Timing\n *\n * Three moments drive an attack, and they come from EVENT MARKERS on the clip when it has them:\n *\n   *   hit       the blade becomes ACTIVE: from here until `hitEnd` it is swept every frame and damages\n *             each enemy hurtbox it touches, once per swing (SoulsHitbox)\n *   hitEnd    the blade stops being active\n *   combo     from here a buffered attack chains into `next`\n *   recover   from here a buffered roll or drink may cancel the rest of the swing\n *\n * Author them on the clip's timeline in the Animation editor. A clip with no `hit` event uses the\n * `hitTime`/`comboTime`/`recoverTime` fields below instead (CLIP seconds from the move's start, i.e.\n * before its state's speed), so a freshly imported animation is playable straight away and only gets\n * better once marked up.\n *\n * ## Animation\n *\n * `animTrigger` names the animator trigger that plays the move: the player's animator has a state entered by\n * it, whose clip, speed, start in the clip and blends are the move's animation. A state that extracts its\n * root travel moves the body by the clip's own hips (an attack whose feet step goes exactly as far as they\n * do); otherwise the `lunge*` drive below does.\n *\n * ## One clip, several attacks\n *\n * A combo can be ONE continuous animation: each move's state plays a segment of it (its start time), and\n * hands over to the next move's state at the segment's end, on that move's trigger. A chained attack\n * restarts nothing -- the animation plays on into it. A segment that is not chained blends out.\n */\nexport default class SoulsMoveNode extends Node {\n  /** The animator trigger that plays this move, e.g. \"Longsword Light1\". Empty: the node's name. */\n  @attribute\n  public animTrigger: TriggerName = ''\n  /** Multipliers on the weapon's attack rating and poise damage. */\n  @attribute\n  public damageMul: number = 1\n  @attribute\n  public poiseMul: number = 1\n  @attribute\n  public staminaCost: number = 16\n  /**\n   * The swing bounces off walls (`blocksSwings` bodies) it reaches before any enemy: sparks, a recoil, no\n   * damage. Heavy slams turn it off and plough through.\n   */\n  @attribute\n  public bounceOff: boolean = true\n  /** Forward drive: from `lungeStart` (clip seconds) for `lungeSeconds`, at `lungeSpeed` m/s. */\n  @attribute\n  public lungeStart: number = 0.1\n  @attribute\n  public lungeSeconds: number = 0.15\n  @attribute\n  public lungeSpeed: number = 2.5\n  /** Seconds after the swing starts during which the player can still turn toward the target. */\n  @attribute\n  public trackSeconds: number = 0.2\n  /** Fallback timings, used only when the clip carries no `hit` event. Clip seconds. */\n  @attribute\n  public hitTime: number = 0.38\n  @attribute\n  public activeSeconds: number = 0.15\n  @attribute\n  public comboTime: number = 0.45\n  @attribute\n  public recoverTime: number = 0.62\n  /** Name of the move a buffered light attack chains into. Empty restarts the chain. */\n  @attribute\n  public next: NodeName = 'Light2'\n  @attribute\n  public isMove: boolean = true\n}\n",
            "scriptVars": {
              "damageMul": 1.05,
              "staminaCost": 26,
              "lungeStart": 0.72,
              "lungeSeconds": 0.2,
              "lungeSpeed": 2,
              "trackSeconds": 0.728,
              "hitTime": 0.97,
              "comboTime": 1.25,
              "recoverTime": 1.57,
              "next": "Light1",
              "animTrigger": "Greatsword Light2",
              "activeSeconds": 0.2
            }
          }
        },
        {
          "parent": "",
          "index": 3,
          "node": {
            "name": "Heavy",
            "type": "node",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "f01e760bd99206e45f8f6bf1a100f851",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport type { NodeName, TriggerName } from 'cleo'\n\n/**\n * Hollow Keep — one attack of a weapon's moveset. Attach to a plain child node of a SoulsWeapon; the\n * node's NAME is what the weapon's `lightMove`/`heavyMove` and other moves' `next` refer to.\n *\n * ## Timing\n *\n * Three moments drive an attack, and they come from EVENT MARKERS on the clip when it has them:\n *\n   *   hit       the blade becomes ACTIVE: from here until `hitEnd` it is swept every frame and damages\n *             each enemy hurtbox it touches, once per swing (SoulsHitbox)\n *   hitEnd    the blade stops being active\n *   combo     from here a buffered attack chains into `next`\n *   recover   from here a buffered roll or drink may cancel the rest of the swing\n *\n * Author them on the clip's timeline in the Animation editor. A clip with no `hit` event uses the\n * `hitTime`/`comboTime`/`recoverTime` fields below instead (CLIP seconds from the move's start, i.e.\n * before its state's speed), so a freshly imported animation is playable straight away and only gets\n * better once marked up.\n *\n * ## Animation\n *\n * `animTrigger` names the animator trigger that plays the move: the player's animator has a state entered by\n * it, whose clip, speed, start in the clip and blends are the move's animation. A state that extracts its\n * root travel moves the body by the clip's own hips (an attack whose feet step goes exactly as far as they\n * do); otherwise the `lunge*` drive below does.\n *\n * ## One clip, several attacks\n *\n * A combo can be ONE continuous animation: each move's state plays a segment of it (its start time), and\n * hands over to the next move's state at the segment's end, on that move's trigger. A chained attack\n * restarts nothing -- the animation plays on into it. A segment that is not chained blends out.\n */\nexport default class SoulsMoveNode extends Node {\n  /** The animator trigger that plays this move, e.g. \"Longsword Light1\". Empty: the node's name. */\n  @attribute\n  public animTrigger: TriggerName = ''\n  /** Multipliers on the weapon's attack rating and poise damage. */\n  @attribute\n  public damageMul: number = 1\n  @attribute\n  public poiseMul: number = 1\n  @attribute\n  public staminaCost: number = 16\n  /**\n   * The swing bounces off walls (`blocksSwings` bodies) it reaches before any enemy: sparks, a recoil, no\n   * damage. Heavy slams turn it off and plough through.\n   */\n  @attribute\n  public bounceOff: boolean = true\n  /** Forward drive: from `lungeStart` (clip seconds) for `lungeSeconds`, at `lungeSpeed` m/s. */\n  @attribute\n  public lungeStart: number = 0.1\n  @attribute\n  public lungeSeconds: number = 0.15\n  @attribute\n  public lungeSpeed: number = 2.5\n  /** Seconds after the swing starts during which the player can still turn toward the target. */\n  @attribute\n  public trackSeconds: number = 0.2\n  /** Fallback timings, used only when the clip carries no `hit` event. Clip seconds. */\n  @attribute\n  public hitTime: number = 0.38\n  @attribute\n  public activeSeconds: number = 0.15\n  @attribute\n  public comboTime: number = 0.45\n  @attribute\n  public recoverTime: number = 0.62\n  /** Name of the move a buffered light attack chains into. Empty restarts the chain. */\n  @attribute\n  public next: NodeName = 'Light2'\n  @attribute\n  public isMove: boolean = true\n}\n",
            "scriptVars": {
              "bounceOff": false,
              "damageMul": 1.7,
              "poiseMul": 2,
              "staminaCost": 42,
              "lungeStart": 0.503,
              "lungeSeconds": 0.2,
              "lungeSpeed": 3,
              "trackSeconds": 0.565,
              "hitTime": 0.753,
              "comboTime": 1.033,
              "recoverTime": 1.353,
              "next": "",
              "animTrigger": "Greatsword Heavy",
              "activeSeconds": 0.2
            }
          }
        }
      ],
      "removed": [],
      "bodies": {},
      "triggers": {},
      "scripts": {}
    }
  }
}
