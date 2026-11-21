{
  "id": "267eba068a2a52d5dd9c40a7843a8e80",
  "name": "barrel_03_1k",
  "nodeJson": {
    "type": "collider",
    "name": "barrel_03_1k",
    "id": "0a5815386484916b9dfea48aece4e185",
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
      "shapes": [
        {
          "type": "cylinder",
          "radius": 0.3207,
          "height": 0.9345,
          "numSegments": 16,
          "offset": [0, 0.4672, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "motionSmoothing": 0,
      "layer": 1
    },
    "children": [
      {
        "id": "cd55c6f571c5ed22e35685dbca7865f0",
        "name": "barrel_03_1k",
        "type": "model",
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "6c30c2d2cef20a136abd950ec82a7114",
            "access": "public"
          },
          "__modelId": {
            "type": "string",
            "value": "737dcb30c61e64d5525f280d65c37163",
            "access": "public"
          },
          "__modelBaseTRS": {
            "type": "string",
            "value": "[0,0,0,0,0,0,1,1,1]",
            "access": "public"
          }
        },
        "model": {
          "geometry": {
            "$geo": {
              "positions": {
                "h": "7e71f6be8a5442a0414bb0c8e7ad7816149f5dfafcd66c4a871a8710311de787",
                "l": 13512
              },
              "normals": {
                "h": "ed1d3b3758223516ef2b5c800cb7549e1ef3e5b0f17ab31225a58f20b2ed3b43",
                "l": 13512
              },
              "tangents": {
                "h": "cdca01214862421e21451d0030f6247fbd73ce12a1895d5ffc4f000e2b40fe13",
                "l": 13512
              },
              "bitangents": {
                "h": "0efefb33a97badb1f3ba762b19d34acd3c1d8b071a95593a26d95e19c8fbbc00",
                "l": 13512
              },
              "texCoords": {
                "h": "8beef731cf49b0074e999170dba6929fabf93d2f99f509c5f65cc847e9aa4f69",
                "l": 9008
              },
              "indices": {
                "h": "56c131ac63e7c19dbaa83f62fe113ee5bc35b14da416656b6c9acd78ff2e28ea",
                "l": 8838,
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
              "baseColorTexture": "barrel_03_diff_1k.jpg",
              "metallicMap": "barrel_03_arm_1k.jpg",
              "roughnessMap": "barrel_03_arm_1k.jpg",
              "normalMap": "barrel_03_nor_gl_1k.jpg"
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
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1]
      }
    ]
  },
  "scripts": {},
  "textureIds": [
    "barrel_03_diff_1k.jpg",
    "barrel_03_arm_1k.jpg",
    "barrel_03_nor_gl_1k.jpg"
  ]
}
