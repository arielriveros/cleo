import { Node } from 'cleo'

/**
 * Valley — turns a windmill's sails. Attach to the `Sails` node, whose origin is the hub and whose local
 * X is the axle (the Valley example builds them that way). Pure decoration: no physics, no gameplay.
 */
export default class ValleyWindmillNode extends Node {
  /** Sail speed in degrees per second; negative turns the other way. */
  public degreesPerSecond: number = 24

  onUpdate(delta: number) {
    this.rotateX(this.degreesPerSecond * delta)
    // Keep the angle small so it never loses precision over a long session.
    if (Math.abs(this.rotation[0]) > 360) this.setRotation([this.rotation[0] % 360, this.rotation[1], this.rotation[2]])
  }
}
