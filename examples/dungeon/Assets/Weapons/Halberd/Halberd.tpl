{
  "id": "d38eaf0a87271719614152b3ed93bb19",
  "name": "Halberd",
  "nodeJson": {
    "id": "bf88ed13ede193c410e89e993936a522",
    "name": "Halberd",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "588387f6a6360b2991d9fef03bdd726b",
        "name": "Mesh",
        "type": "node",
        "position": [0.0139, 0.0708, -0.0315],
        "rotation": [-150.117, -81.128, 83.817],
        "scale": [1, 1, 1],
        "children": [
          {
            "name": "Ornate Mace",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "abd565a29f0fac661b91415d49caeea2",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "23f5e136917b8e0f649f9cc83a0dcb75a2e5dfe2a93e68688674722f5e99624d",
                    "l": 119028
                  },
                  "normals": {
                    "h": "ffeab25d696afb94edef0c3352c3cf559ae496c57f0855a0ef5d2c3ec12960be",
                    "l": 119028
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "a42237664655e0f911c2ffb78483daf8d01e7a147cd5eb62be74b6234c3d42fe",
                    "l": 79352
                  },
                  "indices": {
                    "h": "c8c5ba4c52e2fdf4997122e5fad91eb10ed10ed69a1b2b4f5da1c1bac4be9bcc",
                    "l": 88572,
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
                  "baseColorTexture": "8865bedfe69ccc2d46d95a7a3dced5e7",
                  "metallicRoughnessTexture": "e74da749e0d7d37b2e8666458e37b88d",
                  "occlusionMap": "e74da749e0d7d37b2e8666458e37b88d",
                  "normalMap": "728ccf89c91d18180da014a2e740a7e9"
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
            "id": "0cdf3a6e0f7172d1f5719b64e919ad7f"
          }
        ],
        "variables": {},
        "spawnOnStart": true
      },
      {
        "id": "9973117380b5f778347b21a9b9ed654e",
        "name": "Sounds",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [
          {
            "id": "fe46a849c3702f7a8b9cd143d0a56844",
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
        "value": "8b83eed97827ceb6114ff37561445b12",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "socketAttachment": {
      "target": "parent",
      "socket": "RightHand"
    },
    "script": "import { attribute } from 'cleo/decorators'\nimport type { Vec3 } from 'cleo'\nimport SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'\n\n/**\n * Hollow Keep — the Hollow Warden's halberd. Long reach, a wide head: the hitbox runs from mid-shaft to\n * past the blade, and the Warden's size (the socket's scale) makes it bigger still.\n */\nexport default class SoulsHalberdNode extends SoulsWeaponNode {\n  @attribute\n  public displayName: string = 'Halberd'\n  @attribute\n  public baseDamage: number = 150\n  @attribute\n  public strScaling: number = 0.6\n  @attribute\n  public dexScaling: number = 0.4\n  @attribute\n  public strRequirement: number = 14\n  @attribute\n  public dexRequirement: number = 12\n  @attribute\n  public poiseDamage: number = 40\n  @attribute\n  public bladeStart: Vec3 = [0, 0.4, 0]\n  @attribute\n  public bladeEnd: Vec3 = [0.06, 1.9, 0]\n  @attribute\n  public bladeRadius: number = 0.2\n}\n",
    "scriptVars": {
      "bladeStart": [0, 0.329, 0],
      "bladeEnd": [0, 1.315, 0],
      "bladeRadius": 0.127
    }
  },
  "scripts": {},
  "bodies": {},
  "triggers": {},
  "textureIds": [
    "8865bedfe69ccc2d46d95a7a3dced5e7",
    "e74da749e0d7d37b2e8666458e37b88d",
    "728ccf89c91d18180da014a2e740a7e9"
  ],
  "variant": {
    "baseTemplateId": "20a2e2bd4133caf56852609a6033758d",
    "diff": {
      "version": 1,
      "nodes": {
        "": {
          "merge": {
            "name": "Halberd",
            "variables": {
              "__scriptId": {
                "value": "8b83eed97827ceb6114ff37561445b12"
              }
            },
            "script": "import { attribute } from 'cleo/decorators'\nimport type { Vec3 } from 'cleo'\nimport SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'\n\n/**\n * Hollow Keep — the Hollow Warden's halberd. Long reach, a wide head: the hitbox runs from mid-shaft to\n * past the blade, and the Warden's size (the socket's scale) makes it bigger still.\n */\nexport default class SoulsHalberdNode extends SoulsWeaponNode {\n  @attribute\n  public displayName: string = 'Halberd'\n  @attribute\n  public baseDamage: number = 150\n  @attribute\n  public strScaling: number = 0.6\n  @attribute\n  public dexScaling: number = 0.4\n  @attribute\n  public strRequirement: number = 14\n  @attribute\n  public dexRequirement: number = 12\n  @attribute\n  public poiseDamage: number = 40\n  @attribute\n  public bladeStart: Vec3 = [0, 0.4, 0]\n  @attribute\n  public bladeEnd: Vec3 = [0.06, 1.9, 0]\n  @attribute\n  public bladeRadius: number = 0.2\n}\n",
            "scriptVars": {
              "bladeStart": [0, 0.329, 0],
              "bladeEnd": [0, 1.315, 0],
              "bladeRadius": 0.127
            }
          }
        },
        "Mesh": {
          "merge": {
            "position": [0.0139, 0.0708, -0.0315],
            "rotation": [-150.117, -81.128, 83.817]
          }
        }
      },
      "added": [
        {
          "parent": "Mesh",
          "index": 0,
          "node": {
            "name": "Ornate Mace",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "abd565a29f0fac661b91415d49caeea2",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "23f5e136917b8e0f649f9cc83a0dcb75a2e5dfe2a93e68688674722f5e99624d",
                    "l": 119028
                  },
                  "normals": {
                    "h": "ffeab25d696afb94edef0c3352c3cf559ae496c57f0855a0ef5d2c3ec12960be",
                    "l": 119028
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "a42237664655e0f911c2ffb78483daf8d01e7a147cd5eb62be74b6234c3d42fe",
                    "l": 79352
                  },
                  "indices": {
                    "h": "c8c5ba4c52e2fdf4997122e5fad91eb10ed10ed69a1b2b4f5da1c1bac4be9bcc",
                    "l": 88572,
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
                  "baseColorTexture": "8865bedfe69ccc2d46d95a7a3dced5e7",
                  "metallicRoughnessTexture": "e74da749e0d7d37b2e8666458e37b88d",
                  "occlusionMap": "e74da749e0d7d37b2e8666458e37b88d",
                  "normalMap": "728ccf89c91d18180da014a2e740a7e9"
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
        }
      ],
      "removed": [],
      "bodies": {},
      "triggers": {},
      "scripts": {}
    }
  }
}
