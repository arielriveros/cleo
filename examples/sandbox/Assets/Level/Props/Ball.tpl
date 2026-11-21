{
  "id": "b92fcc325b75b33cbf9bd68188900eda",
  "name": "Ball",
  "nodeJson": {
    "id": "656d8b77d6bb558844ea443de48d769e",
    "name": "Ball",
    "type": "collider",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "6e1f01da073b514d8df0711ca079da4f",
        "name": "Ball",
        "type": "model",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "spawnOnStart": true,
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "0fbd703df098431d4727fce5a138b0ef",
            "access": "public"
          }
        },
        "model": {
          "geometry": {
            "$geo": {
              "positions": {
                "h": "63aa1c98e236e355384cbbf9b5960ba5d68486b1b1a0c60a2ceb6ff12bc7142f",
                "l": 7500
              },
              "normals": {
                "h": "0543d1153f070665fd69c982e992de32f48bd110b3ed408b96f92e74eb47283e",
                "l": 7500
              },
              "tangents": {
                "h": "a483e2c74f43800baa63f83b13bbb56ca90790780e9fd29c4b96a734a1f9fe83",
                "l": 7500
              },
              "bitangents": {
                "h": "03e522ece9757f7d987c06faa2b524a803416729a2ba0946966f91c231e9fd73",
                "l": 7500
              },
              "texCoords": {
                "h": "dc5d81c3d4c3ac1895b38666aaeb71149842a55fb148d0a788a807164bd511f8",
                "l": 5000
              },
              "indices": {
                "h": "aca609f7d0a18dd81fef758e92af40ae2627857b95a0e4c3bc8700fe3c6f974f",
                "l": 6912,
                "bits": 16
              },
              "typed": true
            }
          },
          "material": {
            "type": "pbr",
            "baseColor": [0.35, 0.5, 0.85],
            "metallic": 0,
            "roughness": 0.9,
            "opacity": 1,
            "emissiveFactor": [0, 0, 0],
            "textures": {
              "baseColorTexture": "d4a96a210b1af85c70925ceced937cb7"
            },
            "config": {
              "side": "front",
              "wireframe": false,
              "transparent": false,
              "castShadow": true,
              "probeable": true
            },
            "uvProjection": "box",
            "uvSpace": "object",
            "uvWorldSize": 0.25
          }
        }
      }
    ],
    "variables": {},
    "spawnOnStart": true,
    "collider": {
      "mass": 3,
      "linearDamping": 0.05,
      "angularDamping": 0.05,
      "linearConstraints": [1, 1, 1],
      "angularConstraints": [1, 1, 1],
      "friction": 0.5,
      "restitution": 0.5,
      "simulatePhysics": true,
      "groundProbeDistance": 0,
      "motionSmoothing": 0,
      "simulationMode": "project",
      "simulationRange": 0,
      "canSleep": true,
      "layer": 8,
      "mask": -1,
      "shapes": [
        {
          "type": "sphere",
          "radius": 0.5,
          "offset": [0, 0, 0],
          "rotation": [0, 0, 0]
        }
      ]
    }
  },
  "scripts": {},
  "textureIds": [
    "d4a96a210b1af85c70925ceced937cb7"
  ]
}
