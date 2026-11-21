{
  "id": "6ad9e1f6b7795dd27936ef0cf399ead4",
  "name": "Club",
  "nodeJson": {
    "id": "f549779a826871811309ae2cd1dd5c4b",
    "name": "Club",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "c07c93c3e1a4249868fc15b16c893aae",
        "name": "Mesh",
        "type": "node",
        "position": [0.0139, 0.0708, -0.0315],
        "rotation": [-150.117, -81.128, 83.817],
        "scale": [1, 1, 1],
        "children": [
          {
            "name": "Wooden Axe",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "954c66320192240ec1daf91c20d8f59c",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "d1aa89bad4f7484760f07413cd40fb49b86c856c4406dccd65014b8fae40fb7d",
                    "l": 26700
                  },
                  "normals": {
                    "h": "43720e9232691542631dd388947ad9be57c09dc0b2aa0ac4aee52d2984bb1133",
                    "l": 26700
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "6d737b6ef8fcd832ff73f59283603ebdfd9191d5f5127efda35c5421859d2395",
                    "l": 17800
                  },
                  "indices": {
                    "h": "06f0d8047722ebe840df95f8fbc0e7565e7fbcd526446e460c8091adf8c8c4f0",
                    "l": 20088,
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
                  "baseColorTexture": "a12c626a0cc8e388ad99c86de6bb4d90",
                  "metallicRoughnessTexture": "933a22890e06d573adecbc966a15d820",
                  "occlusionMap": "933a22890e06d573adecbc966a15d820",
                  "normalMap": "43afbd23e6572d311595d660b33692f6"
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
            "id": "ecb9ccca4ac34c070f964da8d499541d"
          }
        ],
        "variables": {},
        "spawnOnStart": true
      },
      {
        "id": "d443fd66e71ff371f37d7100e170dbeb",
        "name": "Sounds",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [
          {
            "id": "3a59b02c3baf22fb7a5bc8f24996e451",
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
        "value": "6379836427407f099f28e18b8f2d90d4",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "socketAttachment": {
      "target": "parent",
      "socket": "RightHand"
    },
    "script": "import { attribute } from 'cleo/decorators'\nimport type { Vec3 } from 'cleo'\nimport SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'\n\n/**\n * Hollow Keep — the Hollows' club. A crude strength weapon; the Hollow's damage comes from its own\n * attacks (SoulsEnemyAttack), so here the club is mostly its hitbox and its look.\n */\nexport default class SoulsClubNode extends SoulsWeaponNode {\n  @attribute\n  public displayName: string = 'Club'\n  @attribute\n  public baseDamage: number = 85\n  @attribute\n  public strScaling: number = 0.7\n  @attribute\n  public strRequirement: number = 10\n  @attribute\n  public poiseDamage: number = 20\n  @attribute\n  public bladeStart: Vec3 = [0, 0.05, 0]\n  @attribute\n  public bladeEnd: Vec3 = [0, 0.72, 0]\n  @attribute\n  public bladeRadius: number = 0.13\n}\n",
    "scriptVars": {
      "bladeStart": [0, 0.124, 0],
      "bladeEnd": [0, 0.494, 0],
      "bladeRadius": 0.129
    }
  },
  "scripts": {},
  "bodies": {},
  "triggers": {},
  "textureIds": [
    "a12c626a0cc8e388ad99c86de6bb4d90",
    "933a22890e06d573adecbc966a15d820",
    "43afbd23e6572d311595d660b33692f6"
  ],
  "variant": {
    "baseTemplateId": "20a2e2bd4133caf56852609a6033758d",
    "diff": {
      "version": 1,
      "nodes": {
        "": {
          "merge": {
            "name": "Club",
            "variables": {
              "__scriptId": {
                "value": "6379836427407f099f28e18b8f2d90d4"
              }
            },
            "script": "import { attribute } from 'cleo/decorators'\nimport type { Vec3 } from 'cleo'\nimport SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'\n\n/**\n * Hollow Keep — the Hollows' club. A crude strength weapon; the Hollow's damage comes from its own\n * attacks (SoulsEnemyAttack), so here the club is mostly its hitbox and its look.\n */\nexport default class SoulsClubNode extends SoulsWeaponNode {\n  @attribute\n  public displayName: string = 'Club'\n  @attribute\n  public baseDamage: number = 85\n  @attribute\n  public strScaling: number = 0.7\n  @attribute\n  public strRequirement: number = 10\n  @attribute\n  public poiseDamage: number = 20\n  @attribute\n  public bladeStart: Vec3 = [0, 0.05, 0]\n  @attribute\n  public bladeEnd: Vec3 = [0, 0.72, 0]\n  @attribute\n  public bladeRadius: number = 0.13\n}\n",
            "scriptVars": {
              "bladeStart": [0, 0.124, 0],
              "bladeEnd": [0, 0.494, 0],
              "bladeRadius": 0.129
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
            "name": "Wooden Axe",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "954c66320192240ec1daf91c20d8f59c",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "d1aa89bad4f7484760f07413cd40fb49b86c856c4406dccd65014b8fae40fb7d",
                    "l": 26700
                  },
                  "normals": {
                    "h": "43720e9232691542631dd388947ad9be57c09dc0b2aa0ac4aee52d2984bb1133",
                    "l": 26700
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "6d737b6ef8fcd832ff73f59283603ebdfd9191d5f5127efda35c5421859d2395",
                    "l": 17800
                  },
                  "indices": {
                    "h": "06f0d8047722ebe840df95f8fbc0e7565e7fbcd526446e460c8091adf8c8c4f0",
                    "l": 20088,
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
                  "baseColorTexture": "a12c626a0cc8e388ad99c86de6bb4d90",
                  "metallicRoughnessTexture": "933a22890e06d573adecbc966a15d820",
                  "occlusionMap": "933a22890e06d573adecbc966a15d820",
                  "normalMap": "43afbd23e6572d311595d660b33692f6"
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
