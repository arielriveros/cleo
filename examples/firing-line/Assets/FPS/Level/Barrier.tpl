{
  "id": "afcb7db1766bec16ba21bee34667b6a3",
  "name": "Barrier",
  "nodeJson": {
    "type": "collider",
    "name": "Barrier",
    "id": "c4587a8c50aa6233a2b7b71ab6837e89",
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
      "motionSmoothing": 0,
      "shapes": [
        {
          "type": "box",
          "width": 1,
          "height": 1,
          "depth": 1,
          "offset": [0, 0, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "layer": 1
    },
    "children": [
      {
        "id": "4b73a01fde5ca2326b1f66d15d370964",
        "name": "Barrier",
        "type": "model",
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "564d74a11a2d1fdb18116ce55c64f342",
            "access": "public"
          }
        },
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
            "baseColor": [0.44, 0.44, 0.42],
            "metallic": 0,
            "roughness": 0.92,
            "reflectance": 0.5,
            "opacity": 1,
            "alphaCutoff": 0,
            "emissiveFactor": [0, 0, 0],
            "emissiveIntensity": 1,
            "displacementScale": 0.05,
            "depthSpace": "uv",
            "invertHeight": false,
            "clipSilhouette": false,
            "uvProjection": "box",
            "uvSpace": "world",
            "uvWorldSize": 3,
            "textures": {},
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
        "ragdoll": null,
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1]
      }
    ]
  },
  "scripts": {},
  "textureIds": []
}
