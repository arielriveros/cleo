# Physics backends

Physics is moving behind a backend-neutral layer, the physics counterpart of the renderer's RHI, so it can
run on engines other than cannon-es. Rapier is the next one planned. Today cannon-es is still the only
backend, and games behave exactly as before: the engine's tests pin the cannon step bit for bit.

## The layer

`src/physics/pal/` (the Physics Abstraction Layer) is laid out like `src/graphics/rhi/`:

| File | What it holds |
|---|---|
| `types.ts` | The vocabulary, as plain data: `ShapeDesc`, `ColliderDesc`, `BodyDesc`, `JointDesc`, `RayOptions`, `RayHit`, event kinds, `BodyHandle` / `JointHandle` |
| `world.ts` | `PhysicsWorld`, the one interface the engine simulates through |
| `capabilities.ts` | `PhysicsCapabilities`, what a backend can do (native capsule, collision group bits, joint limits, …), and the boot log line |
| `createWorld.ts` | The one place that knows every backend: `createPhysicsWorld(kind)` |
| `cannon/` | The cannon-es backend, `CannonWorld`, and everything that only exists because of cannon: its broadphase, the heightfield and convex-SAT patches, the material table, the centre-of-mass bookkeeping |

A `PhysicsWorld` is handle-based and immediate, like the RHI's `Device`. The engine keeps its own objects
and refers to the backend's by handle. Its conventions hold for every backend:

- A body's position and rotation are its **node origin's**, not its centre of mass. Colliders are placed
  from that origin. (cannon has no centre of mass of its own, so its backend keeps the offset itself.)
- Velocities are the centre of mass's, in world space.
- The engine cuts each frame into substeps and calls `step(dt)` once per substep, so every backend steps the
  same way. `onPreSubstep` runs before each one (buoyancy adds its forces there). A force lasts one substep.
- What a step produced is read afterwards: `forEachContact` (the last substep's contacts, normal pointing
  out of the first body) and `drainEvents` (sensor begin/end, in order, since the last drain). Destroying a
  body drops its queued events.
- A body's collision geometry is read back as `colliderParts`, **as the backend simulates it**: cannon
  reports a capsule as its cylinder and two end spheres, and a cylinder with the polyhedron it collides as.
  The parts are placed in the body's collider frame (`getColliderFrame`: the centre of mass on cannon).
  Overlap queries, the trigger↔trigger pass, buoyancy, particle collision and the editor's live trigger
  overlay all measure bodies this way, so they measure exactly what the simulation sees.

## Two different "where"s

**Backend** is which physics engine simulates. **Executor** is which thread steps it:
`src/physics/executor/` holds the inline executor (the main thread) and the worker executor (a Web Worker,
see [Physics threading](physics-threading.md)). `physics.executor` reads `'inline'` or `'worker'`.

## Adding a backend

1. Implement `PhysicsWorld` in `src/physics/pal/<name>/`, with its capabilities.
2. Add it to `PhysicsBackendKind` and to `createPhysicsWorld`. A backend that must load first (Rapier's
   WASM) gets an async acquire beside it, resolved before the engine initializes physics.
3. Add it to the list in `tests/pal/conformance.test.ts` and make that suite pass. It checks behaviour, not
   bits: lifecycle, the node-origin convention, gravity, impulses, one-substep forces, sleep, axis locks,
   every shape kind at rest, contacts, sensor events, rays and every joint kind.

## Status

The layer is being moved in by stages. Every stage keeps the golden traces passing unchanged
(`tests/physicsGoldenTrace.test.ts`, `tests/physicsGoldenB.test.ts`) and the worker equal to the main thread
bit for bit.

| Stage | State |
|---|---|
| Interface, cannon backend, conformance suite | Done |
| `PhysicsSystem` steps, queries rays, reads contacts and trigger events, sets gravity and solver iterations through the interface | Done |
| Overlap queries, trigger↔trigger pass, buoyancy, particle colliders and the editor's trigger overlay read neutral collider descriptions | Done |
| Terrain, foliage and tilemap colliders, ragdolls and joints on engine bodies | Next |
| `RigidBody`, `Trigger` and `Shape` stop being cannon objects | Planned |
| The worker protocol carries descriptions instead of cannon shapes | Planned |
| A test keeps `cannon-es` inside `src/physics/pal/cannon/`; the project chooses its backend | Planned |

Until the `RigidBody` stage, `node.body` is still a cannon body, as [Physics threading](physics-threading.md)
describes.

## What a Rapier backend needs to settle

Questions to answer in a spike before the Rapier backend is written:

- Does a manually slept body stay asleep with automatic sleep off? The engine freezes far bodies that way.
- Do queries work on a world that is never stepped (the worker's main-thread mirror)?
- Damping: cannon's is `v *= (1 − d)^dt`, Rapier's `v *= 1 / (1 + d·dt)`. Convert.
- Collision groups are 16 + 16 bits in Rapier (cannon 32): check the ragdoll and hitbox layers fit.
- Rapier's heightfield is column-major and centred; the layer's starts at its origin.
- Rapier's joints have no `maxForce`, and a cone limit means a generic joint.
- `collisionResponse = false` maps to empty solver groups, which keeps contacts for grounding.
- `forEachContact` comes from `contactPairsWith` over the moving bodies.
- Only `@dimforge/rapier3d-compat` (WASM embedded in the JS) works in a published game, which runs from
  `file://` with its physics worker inlined.
