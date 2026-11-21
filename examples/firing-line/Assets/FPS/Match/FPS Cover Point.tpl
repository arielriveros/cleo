{
  "id": "7459852c4ca07dc51c3dfe865282a38d",
  "name": "FPS Cover Point",
  "nodeJson": {
    "id": "03308b25d4e149c312d4eef2eb4f30da",
    "name": "FPS Cover Point",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "efce757ea4000477edc7481b15c38107",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * FPS example — a marker the Game Manager reads. Attach to a Spawn Point or Cover Point template:\n *\n *   kind 'spawn'   a place fighters start and respawn; its facing (the node's +Z) is the way they look\n *   kind 'cover'   a spot a bot may crouch behind; the manager checks it is out of a threat's sight\n *\n * It only sets the variable the manager finds it by (`fpsSpawn` / `fpsCover`). The node is invisible in\n * play; the template draws a small gizmo for the editor.\n */\nexport default class FpsMarkerNode extends Node {\n  @attribute\n  public kind: 'spawn' | 'cover' = 'spawn'\n\n  onStart() {\n    this.setVariable(this.kind === 'cover' ? 'fpsCover' : 'fpsSpawn', true, 'boolean', 'public')\n  }\n}\n",
    "scriptVars": {
      "kind": "cover"
    }
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
