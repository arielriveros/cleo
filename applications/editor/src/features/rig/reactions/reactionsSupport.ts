import { PHYSICS_BACKENDS } from 'cleo'
import { useCleoEngine } from '../../EngineContext'

/**
 * Whether characters react here: reactions run on the Jolt backend alone (PhysicsCapabilities.reactions), the one
 * the project runs on (a Jolt project fallen back to another has none). With the backend's name, for the warning
 * the Reactions tab and the animator's reaction rows show when it does not.
 */
export function useReactionsSupported(): { supported: boolean; backendName: string } {
  const { instance } = useCleoEngine()
  const physics = instance?.physics
  const supported = !physics || (physics.capabilities ? physics.capabilities.reactions : physics.backend === 'jolt')
  const backendName = physics ? PHYSICS_BACKENDS.find(b => b.request === physics.backend)?.label ?? physics.backend : ''
  return { supported, backendName }
}
