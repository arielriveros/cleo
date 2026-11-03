# Physics threading

Where the physics step runs, and what changes when it runs in a Web Worker.

## Main thread or worker

By default the physics step runs in a Web Worker while the frame renders. The project option **Physics
thread** (Options ▸ Engine ▸ Runtime) chooses:

| Setting | What happens |
|---|---|
| **Worker** | The step runs in a Web Worker while the frame renders. The default. A device that cannot run it steps on the main thread instead: no Web Workers, a single CPU core, or a worker that fails to start or fails later (physics carries on from its last step). The reason shows under Performance ▸ Workers. |
| **Auto** | Starts on the main thread. After two seconds of play it moves to the worker if physics costs 1.5 ms a frame or more (or 40+ moving bodies) on a machine with 4+ cores. It comes back to the main thread if the worker is late on more than 10% of frames for two 3-second windows in a row (one bad window is a hitch, and is ignored), and tries the worker again 30 seconds later. |
| **Main thread** | The step runs inside the frame: input, then physics, then scripts, then render. |

Projects saved before the worker became the default stored **Main thread** without anyone choosing it,
so they open on **Worker**. Choose Main thread again to keep it.

`?physicsWorker=off|on|auto` in the page URL, or `localStorage.cleo_physics_worker`, overrides the project
on one machine. A published game reads the same option; its player carries the worker inline, so it also
runs from a local folder.

In the editor, Options ▸ Engine ▸ Performance ▸ **Workers** shows where the step runs and what the worker
costs, and its switch sets that same per-machine override. The numbers are also in `physics.stats`
(`workerStepMs`, `syncMs`, `workerRoundTripMs`, `workerFramesLate`, …) and `physics.workerStatus`.

## What stays the same

Everything a script touches stays on the main thread and keeps working unchanged:

- `node.body` reads and writes the main thread's copy of the world. Writing its velocity, applying a force
  or an impulse, teleporting it, putting it to sleep: all of it is picked up at the end of the frame and
  sent to the worker.
- Raycasts, overlaps and sweeps, the ground probe, `isGrounded`, the camera boom, triggers and the
  trigger-to-trigger pass all run on the main thread against the same bodies.
- Trigger enter and exit, first contacts (`onCollision`, `body.onCollide`), buoyancy and ragdolls behave
  the same. First contacts are delivered after the step, on the main thread as in the worker.

## What changes

- **Bodies are drawn about one frame behind.** The worker steps while the frame renders, so each step is
  sent before anyone knows how long the frame that shows it will last, and it reaches one predicted frame
  ahead (the average of recent frames). Each node is drawn from the body's last steps, interpolated at a
  drawn time that advances by exactly each frame's delta and sits about one frame behind the clock. Motion
  is therefore paced exactly like the frames, as on the main thread, and a frame that runs long still lands
  inside steps already taken instead of being guessed. The cost is about one frame of visual delay
  (17 ms at 60 fps) for bodies; scripts still read the latest simulated body.
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

## How it works

The main thread keeps its world (see [Physics backends](physics-backends.md)) and does not step it while
the worker does. At the end of each frame (`PhysicsSystem.endFrame`, after scripts and before render) what
changed in it since the worker was last told is posted with the step. The worker keeps a copy of the world
on the same backend and steps it exactly as the inline executor steps the original. At the start of the
next frame the result — poses, velocities, sleep states, the last substep's contacts, trigger events and
first contacts in the order the step raised them, buoyancy — is written back into the world, and each
dynamic body's node is drawn interpolated from its last steps (`WorkerExecutor.visualPose`, with a history
of 32 steps per body). One step is in flight at a time. If the worker fails, physics falls back to the main
thread and carries on from the worker's last step.

How the world is copied is its backend's business; the timing, the drawing, the messaging and the
fallback are the same on every backend. Each backend brings two ends (`physics/pal/replication.ts`): a
**mirror** over the main thread's world, which diffs it each frame and writes each result back, and a
**replica** in the worker, which builds the copy from those diffs. cannon's
(`physics/pal/cannon/mirror.ts`, `replica.ts`, `replicaCodec.ts`) sends bodies, shapes and constraints as
data, built with the same setup code (`physics/pal/cannon/worldConfig.ts`), and carries what a rebuilt
body cannot measure again the same way (its inertia, a lock's frame, a hinge's exact axes). Rapier's
(`physics/pal/copy/describedMirror.ts`, `describedReplica.ts`) sends each body as its description and each joint as the
record it was built from. The worker loads Rapier's WASM before it builds the copy, and messages that
arrive meanwhile wait in order.

**How the result comes back.** A posted reply is a task on the main thread, and the browser only runs it
once the thread is free: after the frame's render. Measured in the Valley, a 1.5 ms step came back 17 ms
after it was sent and was ready only 0.2 ms before the next frame, so any frame that started first had
no result (a *late* frame). On a **cross-origin isolated** page the worker writes each result into a
`SharedArrayBuffer` instead, and the main thread reads it the moment its frame starts
(`physics/worker/sharedReply.ts`): the same scene then measured a 1.5 ms round trip and no late frames.
The editor's and the Creator's dev servers send the headers that isolate the page
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`, from
`crossOriginIsolationPlugin` in `applications/app-kit/vite.preset.ts`). A page served without them (a
published web game on a host that does not send them, the packaged desktop app on `file://`) falls back
to messages, which work the same, just later. Performance ▸ Workers shows which: *replies · shared memory*
or *messages*.

At a steady frame rate each step is exactly the frame's delta, and the engine's tests hold the worker to
the inline step bit for bit on two mixed scenes (`tests/physicsWorkerParity.test.ts`,
`tests/physicsGoldenB.test.ts`, which adds ragdolls, offset centres of mass, continuous triggers and
pooled foliage).
`tests/physicsWorkerSmoothness.test.ts` covers how bodies are drawn on uneven frames, through late steps,
and under scripts that move them.

Code: `src/physics/executor/` (the inline and worker executors), `src/physics/worker/` (the messages, the
worker's step loop, the shared-memory replies) and each backend's mirror and replica
(`src/physics/pal/replication.ts`).

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

At 50–55 fps (same scene, render cost lowered so frames are short; 2026-11-02):

| | Main thread | Worker, drawn at the clock | Worker, drawn a frame behind |
|---|---|---|---|
| Player speed error, rms | 0.14–0.17% | 2.6% | 0.18–0.23% |
| Player speed error, worst | 1.0–2.3% | 30% | 1.7–2.7% |
| Camera speed error, worst | 3.9–5.7% | 49% | 4.8–5.7% |

Drawing at the clock had to extrapolate on every frame longer than predicted, and at short frames that
is most of them; there were no late steps in either run.

Main-thread physics drops by about 63%, and the Valley ships with **Worker**. A game whose physics costs
well under a millisecond (one character and some props) gains little from the worker and pays a little
for the copying; **Main thread** is the choice there.
