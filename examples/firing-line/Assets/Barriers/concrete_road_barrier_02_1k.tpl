{
  "id": "db160aa0e4c96b5cc8a34142242e8cce",
  "name": "concrete_road_barrier_02_1k",
  "nodeJson": {
    "type": "collider",
    "name": "concrete_road_barrier_02_1k",
    "id": "28fd3e24d91bc223f57ce3ba0be58a49",
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
          "type": "box",
          "width": 1.5889,
          "height": 1.1287,
          "depth": 0.4488,
          "offset": [0.0066, 0.5615, -0.0335],
          "rotation": [0, 0, 0]
        }
      ],
      "motionSmoothing": 0,
      "layer": 1
    },
    "children": [
      {
        "id": "c3f6897a87dfcf176f12a880707734fd",
        "name": "concrete_road_barrier_02_1k",
        "type": "model",
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "b4098a1ee9a27b0c77cdb62fbbf2ef86",
            "access": "public"
          },
          "__modelId": {
            "type": "string",
            "value": "e1799234a6a24876b1db93b20991fc6b",
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
                "h": "0ad899ea2567230a798b77801c4ca198474a42c9d442cbf01c3a7bca5e8b526d",
                "l": 149988
              },
              "normals": {
                "h": "8ae3d2b0d1fa075b7dbc0fd8309966da34b45e41961e243e5a57d70f9a79dd50",
                "l": 149988
              },
              "tangents": {
                "h": "1a30f71fca047b92b4421e34c54a2987513cba5795e953bdacceb5216ad9dc12",
                "l": 149988
              },
              "bitangents": {
                "h": "10335f783f95c6669a12285775a4ec10fcf0e5dadc8653ab812de6f18c7bffba",
                "l": 149988
              },
              "texCoords": {
                "h": "601173ccd902b82bc84a47eaa186d9aa13fc4b7ce124f0f89f6f8c6e3d36504d",
                "l": 99992
              },
              "indices": {
                "h": "028d2e2c2deac9b8a5c03ecda18e8ceba7d7ad07cff18afef6b761c4eee46dad",
                "l": 142932,
                "bits": 16
              },
              "typed": true
            }
          },
          "material": {
            "type": "pbr",
            "baseColor": [1, 1, 1],
            "metallic": 0,
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
              "baseColorTexture": "concrete_road_barrier_02_diff_1k.jpg",
              "metallicMap": "concrete_road_barrier_02_arm_1k.jpg",
              "roughnessMap": "concrete_road_barrier_02_arm_1k.jpg",
              "normalMap": "concrete_road_barrier_02_nor_gl_1k.jpg"
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
    "concrete_road_barrier_02_diff_1k.jpg",
    "concrete_road_barrier_02_arm_1k.jpg",
    "concrete_road_barrier_02_nor_gl_1k.jpg"
  ]
}
