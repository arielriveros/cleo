{
  "id": "2b4f443d81abc5261251a9248e0b664d",
  "name": "Prop Tanks 01 B",
  "nodeJson": {
    "type": "collider",
    "name": "Prop Tanks 01 B",
    "id": "f5a1d701b3e710465ba0a7c7b826eafc",
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
          "width": 2.0999999999999996,
          "height": 0.9799999999999999,
          "depth": 2.0999999999999996,
          "offset": [0, 0.48999999999999994, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "layer": 1
    },
    "children": [
      {
        "id": "4a8e301494b37ecdb5b8a0c2b4f3bf63",
        "name": "Prop Tanks 01",
        "type": "node",
        "children": [
          {
            "id": "23a8ca481d1b2fd7aab8c346d4891625",
            "name": "SM_Barrel_01_Asset_0",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__materialId": {
                "type": "string",
                "value": "67cbd6664a16b0f5d12983f3da0f028f",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "a98c7a78b9a0c1cebe11be7d857e2653897177c726472739ec090aa8df774328",
                    "l": 120924
                  },
                  "normals": {
                    "h": "8a513f7175b4f19456c7d954f9cca4c28695d53705437f0c3787ed5f9976aeb1",
                    "l": 120924
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "2a9bcb12c6390b60e04cb0e33e75bf61bef4f92d3aabc7dcf0669f637a27824a",
                    "l": 80616
                  },
                  "indices": {
                    "h": "1ed01dfc20233dc33f144c2373177a623ce88065d98123675d33f64521db9115",
                    "l": 81558,
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
                  "baseColorTexture": "14169f23b9a28c059db5370996153269",
                  "metallicMap": "0b285286f1d27414d0556fc2b2788ca3",
                  "roughnessMap": "0b285286f1d27414d0556fc2b2788ca3",
                  "normalMap": "97d1ad27f1ced565b4a2cdcdf8154328",
                  "occlusionMap": "0b285286f1d27414d0556fc2b2788ca3"
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
            "value": "9a1a1d4a15a849feda27e714024f305b",
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
    "14169f23b9a28c059db5370996153269",
    "0b285286f1d27414d0556fc2b2788ca3",
    "97d1ad27f1ced565b4a2cdcdf8154328"
  ],
  "variant": {
    "baseTemplateId": "f896aebf3bf91297ef174ca255954743",
    "diff": {
      "version": 2,
      "nodes": {
        "": {
          "merge": {
            "name": "Prop Tanks 01 B",
            "collider": {
              "shapes": [
                {
                  "type": "box",
                  "width": 2.0999999999999996,
                  "height": 0.9799999999999999,
                  "depth": 2.0999999999999996,
                  "offset": [0, 0.48999999999999994, 0],
                  "rotation": [0, 0, 0]
                }
              ]
            }
          }
        }
      },
      "added": [],
      "removed": [],
      "scripts": {}
    }
  }
}
