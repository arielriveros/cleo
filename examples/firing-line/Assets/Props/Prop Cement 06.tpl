{
  "id": "3a8ac49e30349e39aefd836ea599ac7a",
  "name": "Prop Cement 06",
  "nodeJson": {
    "type": "collider",
    "name": "Prop Cement 06",
    "id": "065a49163a65b6b9ffaa0c408b82d323",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
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
      "simulationMode": "project",
      "simulationRange": 0,
      "canSleep": false,
      "motionSmoothing": 0,
      "shapes": [
        {
          "type": "box",
          "width": 1.6744999999999999,
          "height": 0.85,
          "depth": 1.5725,
          "offset": [0, 0.425, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "layer": 1
    },
    "children": [
      {
        "id": "645d7f0973152a2e92987bf71c8f9804",
        "name": "Prop Cement 06",
        "type": "node",
        "children": [
          {
            "id": "a5a08e08db8f896f1382480e67b3d1a5",
            "name": "lp_M_cement_0",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "637386dbfea1e755a0be5e61d60a400b",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "9bb6157086b2ab470caca3f7d91e994c71856fed6e7114a7bdd92b921e8aa24a",
                    "l": 14820
                  },
                  "normals": {
                    "h": "d5ee3046f489c914fc0c4b2a6e81e8e9453a228027329a1a88a73d84d0a9e187",
                    "l": 14820
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "bf656976112d00c688bf253b1d7df716dca1fbe8c904aef925743e1f82800897",
                    "l": 9880
                  },
                  "indices": {
                    "h": "d803c11507f9beb61ffe73631a131d4f948638a14ec1c6e6e5ba4820556b435a",
                    "l": 11574,
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
                "alphaCutoff": 0,
                "emissiveFactor": [0, 0, 0],
                "emissiveIntensity": 1,
                "displacementScale": 0.05,
                "depthSpace": "world",
                "invertHeight": false,
                "clipSilhouette": false,
                "textures": {
                  "baseColorTexture": "14bbb0aa36a8b892b6c252c802c0d8da",
                  "metallicMap": "9c56f88a5891a6abecea592058395479",
                  "roughnessMap": "9c56f88a5891a6abecea592058395479",
                  "normalMap": "0eda421d940d113feb59d8bdab3e0b35"
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
        ],
        "variables": {
          "__modelId": {
            "type": "string",
            "value": "17e51faff95e4755761170a3d0a3329f",
            "access": "public"
          },
          "__modelBaseTRS": {
            "type": "string",
            "value": "[0,0,0,0,0,0,1,1,1]",
            "access": "public"
          }
        },
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1]
      }
    ]
  },
  "scripts": {},
  "textureIds": [
    "14bbb0aa36a8b892b6c252c802c0d8da",
    "9c56f88a5891a6abecea592058395479",
    "0eda421d940d113feb59d8bdab3e0b35"
  ]
}
