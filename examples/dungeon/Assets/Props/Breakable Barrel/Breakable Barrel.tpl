{
  "id": "2dda4253ad49ac5d9371641596cffe2f",
  "name": "Breakable Barrel",
  "nodeJson": {
    "id": "18d88e8743e0734534ee19f613555d52",
    "name": "Breakable Barrel",
    "type": "collider",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "64715003becab0d55da358bfd576b30f",
        "name": "Mesh",
        "type": "model",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "145041c2769372384da0cc0856441af6",
            "access": "public"
          }
        },
        "spawnOnStart": true,
        "model": {
          "geometry": {
            "$geo": {
              "positions": {
                "h": "96e46ca6b1d6d951c13ad9f14e1911dd35854b6f82b37518ada4a2f9a9845fff",
                "l": 128652
              },
              "normals": {
                "h": "f9c083cf5a8663c83cf63eda268a49496fce5de83cf9e5cc03030ae2d4a7430d",
                "l": 128652
              },
              "empty": [
                "tangents",
                "bitangents"
              ],
              "texCoords": {
                "h": "d06668fe5a052b86e66901f21e2e914197af2544ad2c3a4a081d31e1d950154f",
                "l": 85768
              },
              "indices": {
                "h": "efc7e9cf594d7a011890d08fb905d2a44caa6159efc07c627da1255434411846",
                "l": 67104,
                "bits": 16
              },
              "typed": true
            }
          },
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
              "baseColorTexture": "4df432fb56ee0bf681320452af821932",
              "metallicRoughnessTexture": "1ca9f2abc70c17b161dc148016fd97ef",
              "occlusionMap": "1ca9f2abc70c17b161dc148016fd97ef",
              "normalMap": "2839b83672f74deb30cf19cba2df79a9"
            },
            "config": {
              "side": "front",
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
      },
      {
        "id": "1a5c94e4f38328046f0c4b12e881cfb7",
        "name": "Hurtbox",
        "type": "trigger",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true,
        "sensor": {
          "shapes": [
            {
              "type": "cylinder",
              "radius": 0.37150007486343384,
              "height": 0.9167808294296265,
              "numSegments": 12,
              "offset": [0, 0.45839041471481323, 0],
              "rotation": [0, 0, 0]
            }
          ],
          "layer": 512,
          "mask": 1024,
          "detectTriggers": true,
          "continuous": false,
          "enabled": true
        }
      },
      {
        "id": "bb5ef2a17ebaaff2c65f676d3e64508b",
        "name": "Sounds",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [
          {
            "id": "5169a0896b6fc77f86df07ad3680537c",
            "name": "Break",
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
        "name": "Breakable Barrel Trigger",
        "id": "18d88e8743e0734534ee19f613555d52:trigger",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "sensor": {
          "shapes": [
            {
              "type": "box",
              "width": 1.7430001497268677,
              "height": 1.3167808294296264,
              "depth": 1.7430001497268677,
              "offset": [0, 0.6583904147148132, 0],
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
        "value": "3ea205e7fec056a17e81758f4bc11f00",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport type { SoundName, TemplateName } from 'cleo'\nimport { playDetached } from '@/Core/Scripts/SoulsAudio'\n\n/**\n * A prop that shatters: struck by the player's swing, or rolled into, it swaps itself for a pile of\n * physics debris (a separate template, `debrisTemplate`) and dissolves away. Attach to the root of\n *\n *   Breakable Barrel     this script + a STATIC body (it blocks like any prop) + a trigger a little\n *   ├── Mesh             wider than the body (how a roll is noticed before the body stops it)\n *   ├── Hurtbox          a trigger the size of the body, in the enemy hurtbox layer: what a blade hits\n *   └── Sounds           Break\n *\n * It is a target for the player's swings -- `team = 'enemy'`, `receiveHit` and its Hurtbox are what\n * SoulsHitbox looks for -- without being an enemy: nothing registers it with the manager, so lock-on, the\n * HUD and the enemy count never see it. Not `blocksSwings`: a blade that bounced off it could never break it.\n */\nexport default class SoulsBreakableNode extends Node {\n  /** The template spawned in its place, one physics body per piece. See SoulsDebris. */\n  @attribute\n  public debrisTemplate: TemplateName = 'Barrel Debris'\n  /** Metres per second the pieces leave at, along the blow. */\n  @attribute\n  public breakSpeed: number = 3.5\n  /** A roll breaks it only this fast or faster (metres per second). */\n  @attribute\n  public rollBreakSpeed: number = 2\n  @attribute\n  public breakSound: SoundName = 'Break'\n  @attribute\n  public team: string = 'enemy'\n  @attribute\n  public isBreakable: boolean = true\n  @attribute\n  public isBroken: boolean = false\n  @attribute\n  public hurtboxActive: boolean = true\n\n  private _inside: Node[] = []\n\n  /** SoulsHitbox's damage hook: any hit breaks it, pushed away from whoever struck. */\n  public receiveHit(_damage: number, _poise: number, from: Node, _point?: ArrayLike<number>): boolean {\n    if (this.isBroken) return false\n    const me = this.worldPosition\n    const at = from ? from.worldPosition : me\n    this.shatter([me[0] - at[0], 0.6, me[2] - at[2]])\n    return true\n  }\n\n  onStart() {\n    // The roll zone is a Trigger of its own under the barrel (the Hurtbox is SoulsHitbox's): hear it here.\n    for (const zone of this.children) {\n      if (zone.nodeType !== 'trigger' || zone.name === 'Hurtbox') continue\n      zone.onTriggerEnter = (other: Node) => this.onTriggerEnter(other)\n      zone.onTriggerExit = (other: Node) => this.onTriggerExit(other)\n    }\n  }\n\n  onTriggerEnter(other: Node) {\n    // What came in is a body: a character's is its Collider, and the character is what rolls.\n    const who = other?.character ?? other\n    if (who && !this._inside.includes(who)) this._inside.push(who)\n  }\n\n  onTriggerExit(other: Node) {\n    const who = other?.character ?? other\n    this._inside = this._inside.filter(n => n !== who)\n  }\n\n  onUpdate() {\n    if (this.isBroken) return\n    // Rolled into: the player is inside the zone mid-roll and actually moving.\n    for (const n of this._inside) {\n      const p = n as any\n      if (p.actionState !== 'roll') continue\n      const v = p.velocity as ArrayLike<number> | undefined\n      if (v && Math.hypot(v[0], v[2]) < this.rollBreakSpeed) continue\n      this.shatter(v ? [v[0], 0.4, v[2]] : [0, 0.4, 0])\n      return\n    }\n  }\n\n  /**\n   * Break now, the pieces leaving along `push` (any length; its direction is used). Spawns the debris\n   * where this stands, then removes itself -- which dissolves whatever is left of it (see Node.remove).\n   */\n  public shatter(push: ArrayLike<number> = [0, 0.5, 0]): void {\n    if (this.isBroken) return\n    this.isBroken = true\n    this.hurtboxActive = false\n    const len = Math.hypot(push[0], push[1], push[2]) || 1\n    const velocity = [push[0] / len * this.breakSpeed, push[1] / len * this.breakSpeed, push[2] / len * this.breakSpeed]\n\n    const scene = this.scene as any\n    const at = Array.from(this.worldPosition)\n    const rot = Array.from(this.rotation as ArrayLike<number>)\n    let debris: any = null\n    try { debris = scene?.instantiate?.(this.debrisTemplate, { position: at, rotation: rot }) } catch { debris = null }\n    debris?.burst?.(velocity)\n\n    playDetached(this, this.breakSound)\n    // Its own body and mesh go at once -- the debris stands exactly where they were.\n    this.remove({ immediate: true })\n  }\n}\n",
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
          "type": "cylinder",
          "radius": 0.37150007486343384,
          "height": 0.9167808294296265,
          "numSegments": 12,
          "offset": [0, 0.45839041471481323, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "layer": 1
    }
  },
  "textureIds": [],
  "scripts": {}
}
