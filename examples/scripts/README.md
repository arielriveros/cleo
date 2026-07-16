# Example scripts — third-person character

Two class-based Script assets that together make a third-person character: WASD movement relative to the
camera, Left Shift to sprint, Space to jump, mouse to look.

| File | Attach to |
|---|---|
| `ThirdPersonPlayable.ts` | the **Playable** root (the node with the RigidBody) |
| `ThirdPersonCameraPivot.ts` | the **Camera Pivot** child |

Script assets live in the editor's own storage, so these are source files to copy in: **Assets → + Add →
Script** (or select the node → Scripts panel → **+ Create Script**), paste the file's contents over the
starter class, then **Save Script**. `tsconfig.json` here is only so the files type-check in your IDE the same
way the in-editor Monaco does — it is not part of the engine build.

## Hierarchy

```
Playable            ← ThirdPersonPlayable.ts   (RigidBody; must sit at the scene root)
├── Model           ← the animated mesh; no script. Its Animator reads `moveSpeed` from its parent
└── Camera Pivot    ← ThirdPersonCameraPivot.ts (raise to head height — the camera orbits this point)
    └── Camera      ← position it in the editor; only its Z is driven by the script
```

The pivot is found by name (`pivotName`), falling back to whichever child contains the Camera — so renaming it
is fine. The **Camera child's X and Y are yours**: set a shoulder offset or a raised eye line in the editor and
the script leaves them alone, driving only Z (the orbit distance, which the mouse wheel controls).

The Playable **must be at the scene root**: `setBody` places the body at the node's world position, but
`setPosition` writes its *local* position into the body, so a parented body ends up in the wrong place.

## Playable body settings (Physics panel)

| | |
|---|---|
| collider | **Capsule** (Add ▸ Capsule) |
| mass | `1` |
| **friction** | **`0`** |
| linearDamping | `0` – `0.05` |
| linearConstraints | **`[1, 1, 1]`** |
| angularConstraints | **`[0, 0, 0]`** |

**Set friction to 0.** A character's script sets its own speed, so surface grip only fights it — the default
0.3 eats **26%** of the commanded speed, and the loss depends on which way you're facing:

| commanded 5 u/s | flat | 10° slope, uphill : downhill |
|---|---|---|
| friction 0.3 | 3.70 | 3.68 : 4.83 — **31% apart** |
| friction 0 | **5.00** | 4.97 : 5.03 — 1% apart |

Slopes split the two directions because running *downhill* the ground falls away, so the body spends a quarter
of its frames out of contact and pays no friction, while uphill it pays in full. Terrain never has to look
sloped for this to bite: the flatten brush approaches its target asymptotically and saving quantizes heights,
so "flat" terrain still has micro-slopes. The character won't slide when idle despite being frictionless —
the script zeroes horizontal velocity when there's no input.

**Use a capsule, not a box.** A box's flat bottom catches on the triangle edges of a terrain heightfield and
hops. Measured on a *perfectly flat* heightfield, walking 4 seconds:

| collider | speed | bounce height | grounded |
|---|---|---|---|
| box | 5 u/s | **101 mm** | 18/240 frames |
| box | 9 u/s | **250 mm** | 10/240 frames |
| capsule | 3–9 u/s | **2.5 mm** | 240/240 frames |

The box is genuinely airborne most of the time, so `isGrounded` is false and jumping barely works. A capsule
rests on an analytic sphere cap and rolls over the same edges. Adding a capsule fits it to the mesh
automatically, including for skinned characters.

Both constraints matter:

- A locked **linear** axis silently kills movement along it. (The old demo character used `[1, 1, 0]`, which
  locks Z — it only worked because it teleported itself with `setPosition` instead of driving velocity.) This
  is the usual cause of *"movement is janky / dead in some directions"*: with Z locked, `W`/`S` do nothing
  while `A`/`D` still work. `onStart` warns if it finds a locked axis.
- Locking **angular** stops physics tipping or spinning the root. That would drag the camera around with it,
  because the pivot is a child — and it's why `ThirdPersonPlayable` turns the *Model*, never itself.

## About `isGrounded`

It allows a **~0.1s grace** after the last real ground contact, for a physics reason rather than a gameplay
one: cannon only emits a contact while two shapes actually overlap, so the solver pushes a resting body out
until the overlap reaches zero, the contact vanishes for a frame, gravity presses it back, and it returns.
A capsule walking flat terrain loses its contact on ~5 frames out of 240 that way. The body never left the
ground, so `false` on those frames is simply the wrong answer. You get coyote-time jumping out of it for free.

Two consequences worth knowing:

- **It is not "am I falling right now"** — it stays true for the grace after you really do walk off a ledge.
  Use `velocity[1]` for that.
- **Never gate movement speed on it.** `const running = ShiftLeft && this.isGrounded` looks reasonable but
  kills air momentum: once you are airborne past the grace, sprint speed drops from `runSpeed` to `walkSpeed`
  *mid-jump*, so a running jump decelerates in flight. Gate the *animation* on grounded if you want, never the
  speed.

**A character that reads `false` for ~0.4s right after play starts has not found a bug** — it is falling. A
node placed above the terrain drops onto it (0.8m takes 0.4s), and `isGrounded` is correctly false the whole
way down. Put the Playable on the ground if you don't want that.

## If something looks wrong

Check the console first — `onStart` warns about the three setups that break movement silently: no rigid body,
a locked linear axis, and no camera pivot child. Beyond those:

| symptom | cause |
|---|---|
| `W` ignores the camera and always runs one fixed way | no pivot found → yaw falls back to world `0` (warned) |
| moves fine on one axis, dead on another | a `0` in **linearConstraints** (warned) |
| slower one way than the other; speed depends on slopes | **friction** — set the body to 0 (see above) |
| slower than `walkSpeed`/`runSpeed` everywhere | friction again; at 0 the body hits the commanded speed exactly |
| character jitters, catches, or gets kicked into the air on terrain | a **box** collider snagging heightfield triangle edges — switch to a **Capsule** |
| jump does nothing even on flat ground | same: a box bouncing on edge contacts is airborne most frames, so `isGrounded` is false |
| sprint drops to a walk / the run animation stutters | something gating `running` or `moveSpeed` on `isGrounded` — see above |
| camera drops to the character's feet | something else is writing the Camera's Y; the script only sets Z |

## Animator setup (Model → Animation editor → State Machine)

`ThirdPersonPlayable` publishes `moveSpeed`: **0 = idle, 0.5 = walking, 1 = running**. It's normalized on
purpose, so retuning `walkSpeed`/`runSpeed` can never invalidate the thresholds below.

1. **Parameter** — add one of type **Variable**, bound to **Parent → `moveSpeed`**, type `number`, default `0`.
   (It shows up under *Parent* because `moveSpeed` is `public`.) Call it e.g. `Speed`.
2. **States** — `Idle` (entry), `Walk`, `Run`, each looping its clip.
3. **Transitions**

   | from → to | condition |
   |---|---|
   | Idle → Walk | `Speed` **greater than** `0.1` |
   | Walk → Run | `Speed` **greater than** `0.6` |
   | Run → Walk | `Speed` **less than** `0.6` |
   | Walk → Idle | `Speed` **less than** `0.1` |

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | move, relative to where the camera is looking |
| `Left Shift` | sprint |
| `Space` | jump (only when grounded — no double jump; ~0.1s of coyote time) |
| mouse | look; click once to lock the pointer, or hold left-drag |
| wheel | zoom the camera between `minDistance` and `maxDistance` |

Every tunable is a public field, so it shows up in the node's **Variables** and can be changed per node
without touching the script. Fields starting with `_` (`_yaw`, `_pitch`) are internal and stay hidden.

## How they fit together

`ThirdPersonPlayable` reads the pivot's **yaw** to decide what "forward" means, then drives
`node.velocity` on the horizontal plane while leaving the vertical component to gravity and the jump. It
turns the Model child toward the direction of travel; the root itself never rotates, which is what keeps the
pivot's local yaw equal to its world yaw — so the camera stays put while the character spins.

Jumping is gated on `node.isGrounded`, which the engine answers from the physics contacts. That covers
terrain and ordinary bodies alike (terrain registers its own collision body), ignores trigger volumes, and
follows whatever direction gravity currently points — so an inverted-gravity level still works.
