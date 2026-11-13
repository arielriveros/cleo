import { Node } from 'cleo'

/**
 * Valley — turns a windmill's sails. Attach to the `Sails` node, whose origin is the hub and whose local
 * X is the axle (the Valley example builds them that way). Pure decoration: no physics, no gameplay.
 *
 * With `followWind` the sails turn with the scene's Wind: `degreesPerSecond` at its usual strength (1),
 * twice as fast in a storm (2), and never slower than a fifth of it however calm, so a sequence building
 * a storm (the Valley Tour's wind presets) speeds the sails up with the grass and the clouds.
 */
export default class ValleyWindmillNode extends Node {
  /** Sail speed in degrees per second at the wind's usual strength; negative turns the other way. */
  public degreesPerSecond: number = 24
  /** Turn faster in a stronger wind (the scene's Wind node), slower in a weaker one. */
  public followWind: boolean = true

  onUpdate(delta: number) {
    const wind: any = this.followWind ? (this.scene as any)?.wind : null
    const strength = wind && wind.visible !== false ? Math.max(0.2, Number(wind.strength) || 0) : 1
    this.rotateX(this.degreesPerSecond * strength * delta)
    // Keep the angle small so it never loses precision over a long session.
    if (Math.abs(this.rotation[0]) > 360) this.setRotation([this.rotation[0] % 360, this.rotation[1], this.rotation[2]])
  }
}
