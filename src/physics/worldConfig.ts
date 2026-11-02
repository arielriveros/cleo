import { World } from 'cannon-es';
import { CleoSAPBroadphase } from './cleoBroadphase';
import { installHeightfieldCollision } from './heightfieldCollision';
import { installConvexSat } from './convexSat';

/**
 * A cannon World set up the way the engine simulates: its broadphase, its heightfield and convex patches,
 * no automatic sleep, exact quaternion normalisation. One function, so the main thread's world and the
 * physics worker's (physics/worker/) are built identically — they must step bit for bit alike.
 * A leaf: cannon-es and the patch modules only, nothing that needs a window.
 */
export function createPhysicsWorld(gravity: ArrayLike<number>): World {
  const world = new World();
  world.gravity.set(gravity[0], gravity[1], gravity[2]);
  // Sweep-and-prune, not cannon's default NaiveBroadphase: hundreds of pooled foliage collider bodies
  // make its O(N^2) pair generation dominate the step.
  // CleoSAPBroadphase rather than cannon's own: its pair loop scanned every static body against every
  // later body regardless of position — see cleoBroadphase.ts.
  world.broadphase = new CleoSAPBroadphase(world);
  // Terrain contacts and rays that only touch the cells a body or ray actually reaches. See
  // heightfieldCollision.ts for what cannon's own resolvers paid on a large landscape.
  installHeightfieldCollision(world);
  // The separating-axis test behind every convex-convex contact, without its parallel repeats and its
  // per-vertex overhead — once measured as 37% of the Valley's physics. See convexSat.ts.
  installConvexSat();
  // cannon's automatic sleep stays off: bodies are put to sleep by PhysicsSystem (out of range, or at
  // rest when they opt in), which knows what may never sleep — a character steered by velocity.
  world.allowSleep = false;
  world.quatNormalizeSkip = 0;
  // Accurate quaternion normalization: the fast approximation blows cone-twist ragdoll joints up to NaN.
  world.quatNormalizeFast = false;
  return world;
}
