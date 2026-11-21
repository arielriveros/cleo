{
  "id": "64182bdac8daf40c6ab07003b39573ac",
  "name": "Maul",
  "nodeJson": {
    "id": "89907fa1f1e4801218c0ba1ffeb440f8",
    "name": "Maul",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "1e92c678a2495c7bb1a642928621858d",
        "name": "Mesh",
        "type": "node",
        "position": [0.0139, 0.0708, -0.0315],
        "rotation": [-150.117, -81.128, 83.817],
        "scale": [1, 1, 1],
        "children": [
          {
            "name": "Strong Knight Maul",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "bfe61b8055a4ea200968c5e8709527e2",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "53032fabc78cba324af9a682144dbca2ae38b813835ca67c8aac1cd008cef39c",
                    "l": 16728
                  },
                  "normals": {
                    "h": "a54d7990b2d9d85830445c7df7cf625b0c82715bef86e8833a1a5328b6b31c4a",
                    "l": 16728
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "3e5e16476130c2bfdb66430c222b24f8f30a216eb490d24691b6a2b0bf9139b7",
                    "l": 11152
                  },
                  "indices": {
                    "h": "5293ccdc1b2637c66df0c4c198e1d29d1f63578f3f02ef17ee63183996df3421",
                    "l": 7824,
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
                "reflectance": 0.5,
                "opacity": 1,
                "emissiveFactor": [0, 0, 0],
                "emissiveIntensity": 1,
                "textures": {
                  "baseColorTexture": "570399fbc8816b58950b648036def466",
                  "metallicRoughnessTexture": "cba8424bf1be863c495735f8c4302074",
                  "occlusionMap": "cba8424bf1be863c495735f8c4302074",
                  "normalMap": "63fc4fd80914382dd49a634adedfb453"
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
            "id": "e6636502c68d758378fec53c8b22685d"
          }
        ],
        "variables": {},
        "spawnOnStart": true
      },
      {
        "id": "54877651f7da34de4003900fa4e0a9ec",
        "name": "Sounds",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [
          {
            "id": "c1b4b91b0ddaf734ccbde695ffb3c53e",
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
      "bladeStart": [0, 0.241, 0],
      "bladeEnd": [0, 0.966, 0],
      "bladeRadius": 0.185
    }
  },
  "scripts": {},
  "bodies": {},
  "triggers": {},
  "textureIds": [
    "570399fbc8816b58950b648036def466",
    "cba8424bf1be863c495735f8c4302074",
    "63fc4fd80914382dd49a634adedfb453"
  ],
  "variant": {
    "baseTemplateId": "20a2e2bd4133caf56852609a6033758d",
    "diff": {
      "version": 1,
      "nodes": {
        "": {
          "merge": {
            "name": "Maul",
            "variables": {
              "__scriptId": {
                "value": "ddabe75cecac8d2ef380fece69dd25b8"
              }
            },
            "script": "import { attribute } from 'cleo/decorators'\nimport type { Vec3 } from 'cleo'\nimport SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'\n\n/**\n * Hollow Keep — the Greatsword: slow, heavy, strength-hungry, and it breaks poise. The player's second\n * weapon and the Elite Knight's only one: both spawn the same \"Greatsword\" template.\n */\nexport default class SoulsGreatswordNode extends SoulsWeaponNode {\n  @attribute\n  public displayName: string = 'Greatsword'\n  @attribute\n  public baseDamage: number = 165\n  @attribute\n  public strScaling: number = 1\n  @attribute\n  public dexScaling: number = 0.15\n  @attribute\n  public strRequirement: number = 16\n  @attribute\n  public dexRequirement: number = 0\n  @attribute\n  public poiseDamage: number = 32\n  @attribute\n  public bladeStart: Vec3 = [0, 0.17, 0]\n  @attribute\n  public bladeEnd: Vec3 = [0, 1.52, 0]\n  @attribute\n  public bladeRadius: number = 0.15\n}\n",
            "scriptVars": {
              "bladeStart": [0, 0.241, 0],
              "bladeEnd": [0, 0.966, 0],
              "bladeRadius": 0.185
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
            "name": "Strong Knight Maul",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "bfe61b8055a4ea200968c5e8709527e2",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "53032fabc78cba324af9a682144dbca2ae38b813835ca67c8aac1cd008cef39c",
                    "l": 16728
                  },
                  "normals": {
                    "h": "a54d7990b2d9d85830445c7df7cf625b0c82715bef86e8833a1a5328b6b31c4a",
                    "l": 16728
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "3e5e16476130c2bfdb66430c222b24f8f30a216eb490d24691b6a2b0bf9139b7",
                    "l": 11152
                  },
                  "indices": {
                    "h": "5293ccdc1b2637c66df0c4c198e1d29d1f63578f3f02ef17ee63183996df3421",
                    "l": 7824,
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
                "reflectance": 0.5,
                "opacity": 1,
                "emissiveFactor": [0, 0, 0],
                "emissiveIntensity": 1,
                "textures": {
                  "baseColorTexture": "570399fbc8816b58950b648036def466",
                  "metallicRoughnessTexture": "cba8424bf1be863c495735f8c4302074",
                  "occlusionMap": "cba8424bf1be863c495735f8c4302074",
                  "normalMap": "63fc4fd80914382dd49a634adedfb453"
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
