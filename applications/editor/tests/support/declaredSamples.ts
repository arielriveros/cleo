import {
  LightNode, DirectionalLight, PointLight, Spotlight, AreaLight, CameraNode, Camera, Sprite, SpriteNode, AnimatedSpriteNode,
  ParallaxLayerNode, TilemapNode, Tilemap, ControllerNode, VehicleNode, WheelNode, UIRootNode,
} from 'cleo'

// Nodes of each class that declares its inspector properties (src/properties), for the tests that read, write
// and draw them: one of each kind where a node comes in kinds (a light, a camera), else `new Class(name)`.

const SAMPLES = new Map<Function, () => any[]>([
  [LightNode, () => [DirectionalLight, PointLight, Spotlight, AreaLight].map(L => new LightNode('probe', new (L as any)({})))],
  [CameraNode, () => (['perspective', 'orthographic'] as const).map(type => new CameraNode('probe', new Camera({ type })))],
  [SpriteNode, () => [new SpriteNode('probe', new Sprite())]],
  [AnimatedSpriteNode, () => [new AnimatedSpriteNode('probe', new Sprite())]],
  [ParallaxLayerNode, () => [new ParallaxLayerNode('probe', new Sprite())]],
  [TilemapNode, () => [
    { kind: 'orthogonal' },
    { kind: 'hexagonal', hexOrientation: 'pointy' },
    { kind: 'hexagonal', hexOrientation: 'flat' },
  ].map(grid => new TilemapNode('probe', new Tilemap(grid as any)))],
  // Its sections follow the source and the goal: a player's, and AI ones that follow, wander and avoid.
  [ControllerNode, () => [{}, { controlSource: 'ai', goal: 'follow' }, { controlSource: 'ai', goal: 'wander', flockRadius: 4 }]
    .map(patch => {
      const node = Object.assign(new ControllerNode('probe'), patch)
      if (patch.controlSource) node.steering.avoidDistance = 2
      return node
    })],
  [VehicleNode, () => [new VehicleNode('probe'), Object.assign(new VehicleNode('probe'), { drivetrain: 'engine', lean: true })]],
  // A wheel's rows follow its vehicle's drive.
  [WheelNode, () => (['none', 'engine', 'motors'] as const).map(drivetrain => {
    const vehicle = Object.assign(new VehicleNode('car'), { drivetrain })
    const wheel = new WheelNode('probe')
    vehicle.addChild(wheel)
    return wheel
  })],
  [UIRootNode, () => [new UIRootNode('probe', 'screen'), new UIRootNode('probe', 'world')]],
])

export function declaredSamples(Class: any): any[] {
  const make = SAMPLES.get(Class)
  if (make) return make()
  try { return [new Class('probe')] } catch { return [] }
}
