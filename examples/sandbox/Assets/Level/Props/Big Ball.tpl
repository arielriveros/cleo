{
  "id": "c5c394421fefba48f99ee7e90ec7d4d0",
  "name": "Big Ball",
  "nodeJson": {
    "id": "3e79509eebc2be4ddd31b20ca85dd6e3",
    "name": "Big Ball",
    "type": "collider",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "dc1344e5a560a6f69f38af7f7f019550",
        "name": "Big Ball",
        "type": "model",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "spawnOnStart": true,
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "655cc06ce9d8bd4658101a4824f36691",
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
            "baseColor": [0.9, 0.62, 0.3],
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
      "mass": 8,
      "linearDamping": 0.05,
      "angularDamping": 0.05,
      "linearConstraints": [1, 1, 1],
      "angularConstraints": [1, 1, 1],
      "friction": 0.5,
      "restitution": 0.4,
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
