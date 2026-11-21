import { LightNode, DirectionalLight, PointLight, Spotlight, AreaLight, CameraNode, Camera } from 'cleo'

// Nodes of each class that declares its inspector properties (src/properties), for the tests that read, write
// and draw them: one of each kind where a node comes in kinds (a light, a camera), else `new Class(name)`.

const SAMPLES = new Map<Function, () => any[]>([
  [LightNode, () => [DirectionalLight, PointLight, Spotlight, AreaLight].map(L => new LightNode('probe', new (L as any)({})))],
  [CameraNode, () => (['perspective', 'orthographic'] as const).map(type => new CameraNode('probe', new Camera({ type })))],
])

export function declaredSamples(Class: any): any[] {
  const make = SAMPLES.get(Class)
  if (make) return make()
  try { return [new Class('probe')] } catch { return [] }
}
