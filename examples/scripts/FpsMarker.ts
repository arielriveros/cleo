import { Node } from 'cleo'

/**
 * FPS example — a marker the Game Manager reads. Attach to a Spawn Point or Cover Point template:
 *
 *   kind 'spawn'   a place fighters start and respawn; its facing (the node's +Z) is the way they look
 *   kind 'cover'   a spot a bot may crouch behind; the manager checks it is out of a threat's sight
 *
 * It only sets the variable the manager finds it by (`fpsSpawn` / `fpsCover`). The node is invisible in
 * play; the template draws a small gizmo for the editor.
 */
export default class FpsMarkerNode extends Node {
  public kind: 'spawn' | 'cover' = 'spawn'

  onStart() {
    this.setVariable(this.kind === 'cover' ? 'fpsCover' : 'fpsSpawn', true, 'boolean', 'public')
  }
}
