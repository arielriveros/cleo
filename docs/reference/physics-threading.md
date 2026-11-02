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

In the editor, Options ▸ Engine ▸ Performance ▸ **Workers** shows where the step runs and what the worker
costs, and its switch sets that same per-machine override. The numbers are also in `physics.stats`
(`workerStepMs`, `syncMs`, `workerRoundTripMs`, `workerFramesLate`, …) and `physics.workerStatus`.

## What stays the same

Everything a script touches stays on the main thread and keeps working unchanged:

- `node.body` is still the real cannon body. Writing its velocity, applying a force or an impulse,
  teleporting it, putting it to sleep: all of it is picked up at the end of the frame and sent to the worker.
- Raycasts, overlaps and sweeps, the ground probe, `isGrounded`, the camera boom, triggers and the
  trigger-to-trigger pass all run on the main thread against the same bodies.
- Trigger enter and exit, first-contact `collide` events, buoyancy and ragdolls behave the same.

## What changes

- **Bodies are drawn at the frame's time.** The worker steps while the frame renders, so each step is sent
  before anyone knows how long the frame that shows it will last. Each step therefore reaches one
  predicted frame ahead (the average of recent frames). Each node is drawn at its frame's actual time,
  between where its body was at the start and at the end of the last step. When a frame runs longer than
  predicted, the body is carried a little further along its velocity.
- **A node and its body can differ by a few milliseconds of motion.** `node.position` and the other node
  transforms are the drawn pose. `node.body` is the latest simulated one, the same pose scripts would see
  inline. Moving or turning the node from a script moves or turns the body by the same amount: root
  motion, a character's turn and `addX` move it as far as they would inline. Writing a world position or
  orientation outright lands within that gap of where it was asked for. Writing `node.body.position` puts
  the body exactly there.
- **A late step is not waited for.** If the worker has not finished by the next frame, that frame draws
  its bodies carried along their velocities. The time rides along with the next step, capped like the
  frame delta (0.1 s). A write made on such a frame still lands. A moved or turned body is moved or
  turned from where the step left it, and a velocity component written replaces only that component.
- **Switching over freezes nothing.** The world is sent to the worker while the main thread keeps stepping
  it. The worker takes over once it has answered.
- **`collide` events arrive without a `contact`.** The event still names the other body.
- A `collide` handler that changes velocities acts one step later than inline, where it ran mid-step.

## How it works

The main thread keeps its cannon `World` as a mirror that never steps. At the end of each frame
(`PhysicsSystem.endFrame`, after scripts and before render) it diffs every body against what the worker
was last told and posts only the changes plus the step. The worker builds its world with the same setup
code (`physics/worldConfig.ts`) and steps it exactly as the inline backend does. At the start of the next
frame the snapshot — poses, velocities, sleep states, the last substep's contacts, trigger events,
first contacts, buoyancy — is written back into the mirror, and each dynamic body's node is drawn
interpolated (`WorkerBackend.visualPose`). One step is in flight at a time, and no SharedArrayBuffer is
used, so no cross-origin isolation headers are needed anywhere. If the worker fails, physics falls back
to the main thread and carries on from the worker's last step.

At a steady frame rate each step is exactly the frame's delta, and the engine's tests hold the worker to
the inline step bit for bit on a mixed scene (`tests/physicsWorkerParity.test.ts`).
`tests/physicsWorkerSmoothness.test.ts` covers how bodies are drawn on uneven frames, through late steps,
and under scripts that move them.

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

How evenly the player is drawn while running straight (same scene, Chrome on WebGPU, 26–28 ms frames,
6 s runs). This is the frame-to-frame error in its on-screen speed, against a running median:

| | Main thread | Worker, before interpolation | Worker |
|---|---|---|---|
| Speed error, rms | 0.2% | 10.7–18.7% | 0.5–1.2% |
| Speed error, p95 | 0.3–0.6% | 21–26% | 1.0–1.1% |
| Late steps | — | 0 | 0 |

The worker used to step each frame by the delta of the frame that had just ended, which made it uneven.

Main-thread physics drops by about 63%. The Valley ships with **Auto**. New projects default to **Main
thread**: a game whose physics costs well under a millisecond (one character and some props) gains
nothing from the worker, and pays for the copying.
