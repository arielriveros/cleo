{
  "id": "1aa70c0cf32415e1e4b2054e6f7cba7d",
  "name": "Gate",
  "nodeJson": {
    "id": "7c765394a89b819d8f6f71ef89a0010d",
    "name": "Gate",
    "type": "collider",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "5f51c2a0d31575723d2c288ebd4623a5",
        "name": "Bars",
        "type": "model",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [3.2, 4, 0.25],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "28e1bde794894d847c34f0170fe579e1",
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
            "baseColor": [0.38, 0.38, 0.4],
            "metallic": 0.9,
            "roughness": 0.45,
            "opacity": 1,
            "emissiveFactor": [0, 0, 0],
            "emissiveIntensity": 1,
            "textures": {},
            "config": {
              "side": "front",
              "wireframe": false,
              "transparent": false,
              "castShadow": true,
              "probeable": true
            }
          }
        }
      },
      {
        "id": "01d2a0fbbace79f787d943830ff7060a",
        "name": "Sounds",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [
          {
            "id": "beeeec7b722cc642e96dc21961ee43c4",
            "name": "Door",
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
        "name": "Gate Trigger",
        "id": "7c765394a89b819d8f6f71ef89a0010d:trigger",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "sensor": {
          "shapes": [
            {
              "type": "box",
              "width": 3.6,
              "height": 4,
              "depth": 4.8,
              "offset": [0, 0, 0],
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
      "blocksSwings": {
        "type": "boolean",
        "value": true,
        "access": "public"
      },
      "navObstacle": {
        "type": "boolean",
        "value": false,
        "access": "public"
      },
      "__scriptId": {
        "type": "string",
        "value": "e8c75538041b8b5f2474752458e7d0d6",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport type { Vec3 } from 'cleo'\nimport { save, find, attribute } from 'cleo/decorators'\nimport { playSound } from '@/Core/Scripts/SoulsAudio'\n\n/**\n * Hollow Keep — a door or portcullis that slides open. Attach to a node with a STATIC box body at the\n * scene root (or under an untransformed group); its visual is the node's own model or a child.\n *\n * Opened by a lever (`openDoor()`). From the locked side it is an interactable that only says why it\n * will not open — the souls convention that tells the player a shortcut exists. \"Locked side\" is the\n * side the node's local +Z points AWAY from when `lockedFromFront` is false, and toward when true.\n *\n * The slide moves the whole node, body included, so nothing else needs to know the door moved. A save keeps\n * `isOpen`, and the door opens itself as the scene starts; the door must NOT be marked Saved as well, or its\n * saved position would be opened a second time.\n */\nexport default class SoulsDoorNode extends Node {\n  /** Offset from the closed position when fully open, in world metres. */\n  @attribute\n  public openOffset: Vec3 = [0, 4.2, 0]\n  @attribute\n  public openSeconds: number = 1.6\n  @save\n  @attribute\n  public isOpen: boolean = false\n  @attribute\n  public lockedText: string = 'Opens from the other side'\n  @attribute\n  public lockedFromFront: boolean = false\n\n  @find('GameManager')\n  private _gm: Node = null\n  private _closed: number[] = [0, 0, 0]\n  private _t: number = 0\n  private _opening: boolean = false\n\n  onStart() {\n    const p = this.position\n    this._closed = [p[0], p[1], p[2]]\n    if (this.isOpen) this._apply(1)\n    ;(this._gm as any)?.registerInteractable?.(this)\n  }\n\n  onDespawn() {\n    ;(this._gm as any)?.unregisterInteractable?.(this)\n  }\n\n  public canInteract(player: Node): boolean {\n    if (this.isOpen || this._opening || !player) return false\n    const p = player.worldPosition\n    const me = this.worldPosition\n    const f = this.worldForward\n    const front = (p[0] - me[0]) * f[0] + (p[2] - me[2]) * f[2] > 0\n    return front === this.lockedFromFront\n  }\n\n  public promptText(player: Node): string { return 'Examine' }\n\n  public interact(player: Node): void {\n    ;(this._gm as any)?.notice?.(this.lockedText)\n  }\n\n  public openDoor(): void {\n    if (this.isOpen || this._opening) return\n    this._opening = true\n    this._t = 0\n    playSound(this, 'Door')\n  }\n\n  onUpdate(delta: number) {\n    if (!this._opening) return\n    this._t = Math.min(1, this._t + delta / Math.max(0.01, this.openSeconds))\n    this._apply(this._t * this._t * (3 - 2 * this._t))\n    if (this._t >= 1) {\n      this._opening = false\n      this.isOpen = true\n      ;(this._gm as any)?.notice?.('A shortcut has opened')\n    }\n  }\n\n  private _apply(k: number): void {\n    this.setPosition([\n      this._closed[0] + this.openOffset[0] * k,\n      this._closed[1] + this.openOffset[1] * k,\n      this._closed[2] + this.openOffset[2] * k,\n    ])\n  }\n}\n",
    "scriptVars": {
      "openOffset": [0, 4.2, 0],
      "lockedText": "Opens from the other side",
      "lockedFromFront": false
    },
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
          "width": 3.2,
          "height": 4,
          "depth": 0.4,
          "offset": [0, 0, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "layer": 1
    }
  },
  "textureIds": [],
  "scripts": {}
}
