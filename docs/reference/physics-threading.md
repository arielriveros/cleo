# Physics threading

Where the physics step runs, and what changes when it runs in a Web Worker.

## Main thread or worker

By default the physics step runs on the main thread, inside each frame: input, then physics, then
scripts, then render. The project option **Physics thread** (Options ▸ Engine ▸ Runtime) can move the
step into a Web Worker:

| Setting | What happens |
|---|---|
| **Main thread** | The step runs inside the frame. The default. |
| **Worker** | The step runs in a Web Worker while the frame renders. |
| **Auto** | Starts on the main thread. After two seconds of play it moves to the worker if physics costs 1.5 ms a frame or more (or 40+ moving bodies) on a machine with 4+ cores, and comes back if the worker is late on more than 10% of frames. |

`?physicsWorker=off|on|auto` in the page URL, or `localStorage.cleo_physics_worker`, overrides the project
on one machine. A published game reads the same option; its player carries the worker inline, so it also
runs from a local folder.

## What stays the same

Everything a script touches stays on the main thread and keeps working unchanged:

- `node.body` is still the real cannon body. Writing its velocity, applying a force or an impulse,
  teleporting it, putting it to sleep: all of it is picked up at the end of the frame and sent to the worker.
- Raycasts, overlaps and sweeps, the ground probe, `isGrounded`, the camera boom, triggers and the
  trigger-to-trigger pass all run on the main thread against the same bodies.
- Trigger enter and exit, first-contact `collide` events, buoyancy and ragdolls behave the same.

## What changes

- **Each step covers the previous frame's time.** A velocity written this frame is simulated while the
  frame renders and seen by scripts next frame — exactly when the inline step, which runs at the start of
  next frame, would show it. The difference is the step's length: the worker steps by the frame that just
  ended, inline by the frame that is starting. At a steady frame rate they are the same, and the engine's
  tests hold the two to the same bits on a mixed scene (`tests/physicsWorkerParity.test.ts`). The very first
  frame after switching applies nothing.
- **A late step is not waited for.** If the worker has not finished by the next frame, that frame applies
  nothing and the time rides along with the next step (capped like the frame delta, 0.1 s).
- **`collide` events arrive without a `contact`.** The event still names the other body.
- A `collide` handler that changes velocities acts one step later than inline, where it ran mid-step.

## How it works

The main thread keeps its cannon `World` as a mirror that never steps. At the end of each frame
(`PhysicsSystem.endFrame`, after scripts and before render) it diffs every body against what the worker
was last told and posts only the changes plus the step. The worker builds its world with the same setup
code (`physics/worldConfig.ts`) and steps it exactly as the inline backend does. At the start of the next
frame the snapshot — poses, velocities, sleep states, the last substep's contacts, trigger events,
first contacts, buoyancy — is written back into the mirror. One step is in flight at a time, and no
SharedArrayBuffer is used, so no cross-origin isolation headers are needed anywhere. If the worker
fails, physics falls back to the main thread and carries on from the worker's last step.

Code: `src/physics/backend/` (the inline and worker backends) and `src/physics/worker/` (protocol,
codec, the worker's world).

## Measurements

The Valley example in the editor (dev server, Play, 8-core desktop, 130 bodies of which 12 moving,
2026-11-02):

| | Main thread | Worker |
|---|---|---|
| Physics on the main thread, per frame | 4.10 ms (step 3.11 ms) | 1.19 ms + 0.35 ms sync |
| Step, measured in the worker | — | 2.63 ms |
| Frame time, average / p95 | 38.2 / 49.6 ms | 34.8 / 42.2 ms |
| Late steps | — | 0 of 237 frames (7 while switching over) |

Main-thread physics drops by about 63%. The Valley ships with **Auto**. New projects default to **Main
thread**: a game whose physics costs well under a millisecond (one character and some props) gains
nothing from the worker, and pays for the copying.
