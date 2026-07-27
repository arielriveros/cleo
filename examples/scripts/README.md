# Example scripts — third-person strafe character

Two class-based Script assets that together make a third-person **strafe** character: WASD movement relative to
the camera, Left Shift to sprint, Space to jump, mouse to look. "Forward" is always where the camera looks —
while moving, the character turns to face the camera and side-steps for A/D (the strafe locomotion set). While
idle, the camera orbits freely around a still character, and swinging it far enough plays a turn-in-place.

| File | Attach to |
|---|---|
| `ThirdPersonPlayable.ts` | the **Playable** root (the node with the RigidBody) |
| `ThirdPersonCameraPivot.ts` | the **Camera Pivot** child — must be a **Camera Rig** node |

Script assets live in the editor's own storage, so these are source files to copy in: **Assets → + Add →
Script** (or select the node → Scripts panel → **+ Create Script**), paste the file's contents over the
starter class, then **Save Script**. `tsconfig.json` here is only so the files type-check in your IDE the same
way the in-editor Monaco does — it is not part of the engine build.

## Hierarchy

```
Playable            ← ThirdPersonPlayable.ts   (RigidBody; must sit at the scene root)
├── Model           ← the animated mesh; no script. Its Animator reads `moveDir` / `turnRequest` from its parent
└── Camera Pivot    ← ThirdPersonCameraPivot.ts on a Camera Rig node (Add ▸ Cameras ▸ Camera Rig).
    └── Camera         Raise the rig to head height — the camera orbits that point.
```

The pivot is found by name (`pivotName`), falling back to whichever child contains the Camera — so renaming it
is fine.

`ThirdPersonCameraPivot.ts` extends **CameraRigNode**, so the pivot node itself has to be a Camera Rig — a
plain Empty will not do. The rig owns the camera's placement, and most of what used to be script fields is now
in the **Camera Rig** inspector:

| Was (script field) | Now (Camera Rig inspector) |
|---|---|
| `distance` | **Arm Length** |
| `lookSpeed` | **Yaw / Pitch Sensitivity** |
| `minPitch` / `maxPitch` | **Pitch Min / Max** (set `-30` / `70` for third person) |
| the Camera child's X/Y | **Socket Offset** |
| — | **Collision** — new: the camera now pulls in at walls and terrain instead of clipping through |

Only the mouse-wheel zoom range (`minDistance`/`maxDistance`/`zoomSpeed`) stays on the script.

**Set the shoulder offset on the rig's Socket Offset, not on the Camera.** The rig rewrites the Camera child's
whole local position every frame, so an offset dragged onto the Camera itself would be overwritten. Existing
scenes are rescued automatically: the script adopts a stray X/Y offset into Socket Offset once at startup.

The rig also runs in the scene's late pass, *after* every `onUpdate`, so the camera can no longer trail the
character by a frame the way a script-driven pivot did.

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
- Locking **angular** stops the physics *solver* tipping or spinning the root on contact. It does **not** stop
  the script: `ThirdPersonPlayable` rotates the body directly (a kinematic set the lock allows) to face the
  camera, and the turn clips' root motion does the same. The camera is **not** dragged when the body turns — a
  Camera Rig's yaw is its *world* yaw (the rig cancels its parent's rotation each frame), so its aim is
  independent of the body underneath it. That is why the Camera Pivot must be a **Camera Rig**, not a plain Empty.

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
| sprint drops to a walk / the run animation stutters | something gating `running` on `isGrounded` — see above |
| the run animation plays on the spot against a wall | the field's Speed axis is bound to an *intent* rather than a measurement — bind it to **Built-in → Parent → `planarSpeed`**, which reports what the body actually did |
| the wrong strafe clip plays for a direction | `moveDir` sample placement in the field doesn't match the script's angle convention — see the field table below (W→0, D→+90, A→-90, S→±180) |
| straight-backwards flickers to a side-strafe | the backward samples aren't duplicated at **both** +180 and -180 — the direction axis is linear, not circular (see the field note) |
| direction changes snap; no blend between strafes | `directionSmoothing` is `0`, or the field's Direction axis is bound to something other than `moveDir`. The keys give a discrete angle, so the script damps it — the field probe itself is read un-smoothed on purpose (it would smear the field editor's preview otherwise) |
| camera drops to the character's feet | something else is writing the Camera's Y; the rig owns the whole camera position |

## Animator setup — the pieces

The strafe system is a **2D Animation Field** (the blend space) for all the ground motion, wrapped in a small
**state machine** that switches between Idle, that field, Jump, and four turn-in-place clips. Build the field
first, then the machine that plays it.

The script publishes three fields for the animator to read; speed comes straight from the engine:

| animator input | source | meaning |
|---|---|---|
| **Direction** | Variable → Parent → `moveDir` | Strafe angle in degrees: `0` ahead (W), `+90` right (D), `-90` left (A), `±180` back (S). The field's **X** axis. |
| **Speed** | **Built-in → Parent → `planarSpeed`** | The character's **real** ground speed in world units (0…`runSpeed`). The field's **Y** axis, and the Idle⇄move gate. Measured, so a character jammed against a wall reads 0 and drops to idle instead of running on the spot. |
| **Jumping** | Variable → Parent → `isJumping` | true from take-off until the feet land. |
| **Turn** | Variable → Parent → `turnRequest` | `0` none, `+1`/`+2` turn 90°/180° right, `-1`/`-2` turn 90°/180° left. Held for the whole turn. |

> Use **`planarSpeed`** (a Built-in), not a normalized script field, for Speed. It ignores falling, so a jump
> never reads as a sprint, and it lets the field's Y axis be in real world units. The other built-ins in the
> picker: `currentSpeed` (total, incl. falling), `rawSpeed` (unsmoothed), `verticalSpeed`, `planarAngle`,
> `worldPlanarAngle`, `isGrounded`.

---

## 1. Build the Locomotion Animation Field (the blend space)

**Assets → + Add → Animation Field** (or from the Model's inspector → skinned-model tab → *New Field*). Pick
the **model asset** whose clips you're blending — a field can only place clips from one model. Name it
`Locomotion`. This opens the Animation Field editor: a 2D plot over a live preview of your character.

**Set the axes** (sidebar):

| axis | bind to param | range | why that range |
|---|---|---|---|
| **X — Direction** | `Direction` | `-180 … 180` | matches `moveDir`: full left-to-right through forward. |
| **Y — Speed** | `Speed` | `0 … 4` | 0 to `runSpeed`. Walk clips sit partway up, run clips at the top. |

> The editor normalizes each axis by its own min/max before any distance math, so a 0…4 Speed axis and a
> −180…180 Direction axis carry equal weight — you don't have to match their numeric scales.

**Place the clips.** Drop each clip at its (Direction, Speed) coordinate. Ten samples: four directions × two
gaits, plus the backward pair mirrored (see the wrap note):

| clip | X (Direction) | Y (Speed) |
|---|---|---|
| walk forward | `0` | `1.5` |
| run forward | `0` | `4` |
| walk right (strafe) | `90` | `1.5` |
| run right | `90` | `4` |
| walk left (strafe) | `-90` | `1.5` |
| run left | `-90` | `4` |
| walk backward | `180` | `1.5` |
| run backward | `180` | `4` |

> **Turn on `wrap` for the Direction axis** (Animation Field panel, Smoothing block — it is on by default for
> new fields). That makes the axis a CIRCLE, so `-180` and `+180` are the same heading and a probe at `-170`
> is ten degrees from the backward clips rather than three hundred and fifty.
>
> This replaces older advice to place the backward clips at **both** `+180` and `-180`. Do not do that any
> more: with `wrap` on, the two ends are literally the same point, so the copies land on top of each other.
> The engine now splits one sample's worth of weight between coincident samples and the panel flags them, so
> a leftover duplicate is harmless — but it is still two rows saying one thing. Without `wrap`, the duplicate
> is still the only way to cover the seam, and the ±180 crossing will lurch through every clip on the way.

**Diagonals are synthesized, not authored.** The gradient-band blend already mixes forward + right for a probe
at 45°, so with only the four cardinal clips a diagonal reads as a blend of the two neighbours — combined with
the script's `directionSmoothing`, that is what makes turning between strafes glide. Dropping real clips at
`±45` / `±135` sharpens it further if you have them, but it is not needed.

> **If a diagonal looks like the legs are fighting rather than blending**, the two clips being mixed start at
> different points in the gait — one on the left foot, one on the right. That is worst at an even mix, which
> is exactly the diagonal. Set **phase** to `0.5` on one of them (or press ½ next to it) to shift it half a
> cycle. If instead the pose *buzzes* at a diagonal, it is the probe rather than the clips: open the State
> Machine panel's Preview, turn on `simulate`, and read the 1s spread column — it names which value is moving.

**Idle is not in this field.** Leave the field to the walk/run motion; idle is a separate state below. (A single
idle sample at the origin would lose to the nearest walk clip at zero speed, because the plot blends by
distance — the character would drift into a strafe while standing still. A separate Idle state sidesteps that
cleanly.)

**Tune with the preview.** Drag the probe around the plot and watch the model. The weight readout shows which
clips are active. If a clip is too short and foot-slides, use the field panel's per-sample **rate scale** — it
flags a clip much shorter than the field's median and sets `rateScale = length/median` in one click.

**Save the field.** Editing it later re-embeds into any machine that plays it automatically.

---

## 2. Build the state machine (Model → Animation editor → State Machine)

**Parameters** (Variables tab) — bind each as in the table at the top:

| name | type | binds to |
|---|---|---|
| `Direction` | Variable (number) | Parent → `moveDir` |
| `Speed` | Variable (number) | **Built-in** → Parent → `planarSpeed` |
| `Jumping` | Variable (boolean) | Parent → `isJumping` |
| `Turn` | Variable (number) | Parent → `turnRequest` |

**States** (drag on the graph canvas):

| state | plays | loop | notes |
|---|---|---|---|
| `Idle` *(entry)* | clip: idle | yes | |
| `Locomotion` | **Field: Locomotion** | yes | set the state's source to **Field**, pick `Locomotion`, and confirm its axis inputs read `Direction` (X) / `Speed` (Y). |
| `Jump` | clip: jump start | **no** | |
| `Turn90L` | clip: turn 90 left | **no** | **Root motion** ON |
| `Turn90R` | clip: turn 90 right | **no** | **Root motion** ON |
| `Turn180L` | clip: turn 180 left | **no** | **Root motion** ON |
| `Turn180R` | clip: turn 180 right | **no** | **Root motion** ON |

> **Enable Root motion on the four turn clips** — the toggle sits between each clip's name and its ✕ in the
> **Clips** panel. That is what makes the turn animation physically rotate the character (the body if it has
> one, else the model node) instead of spinning the mesh back to where it started. Leave it **off** on Idle,
> Jump and the locomotion clips: the locomotion field is driven by physics velocity, so root motion there would
> double-move the character. Root motion applies only to single-clip states — a Field state ignores it.

> **Do not also set a playback Speed/`speedParam` on `Locomotion`.** A field matches speed by *choosing* clips,
> not by playing one faster — binding the movement speed to both the field's Y axis and the state's playback
> rate multiplies it twice (run plays 4× too fast, idle freezes). Switching a state to Field clears the rate
> for you; just don't re-add one. If a clip is still too fast at rate 1, it's genuinely short — fix it with the
> field's per-sample **rate scale**, above.

**Transitions** (drag handle → handle; select an edge to set conditions and the per-edge **blend**). `eq` on the
`Turn` code needs the number-equals operator; the turn conditions are mutually exclusive by construction.

| from → to | conditions | blend |
|---|---|---|
| `Idle → Locomotion` | `Speed > 0.1` **AND** `Jumping is false` | |
| `Locomotion → Idle` | `Speed < 0.1` | |
| `Idle → Turn90R` | `Turn eq 1` | `0.15` |
| `Idle → Turn180R` | `Turn eq 2` | `0.15` |
| `Idle → Turn90L` | `Turn eq -1` | `0.15` |
| `Idle → Turn180L` | `Turn eq -2` | `0.15` |
| each `Turn* → Idle` | `Turn eq 0` **AND** `Speed < 0.1` | `0.15` |
| each `Turn* → Locomotion` | `Speed > 0.1` | `0.15` |
| `Idle → Jump` | `Jumping is true` | `0.1` |
| `Locomotion → Jump` | `Jumping is true` | `0.1` |
| `Jump → Idle` | `Jumping is false` **AND** `Speed < 0.1` | `0.1` |
| `Jump → Locomotion` | `Jumping is false` **AND** `Speed > 0.1` | `0.1` |

That's the whole machine: Idle ⇄ Locomotion on speed, Idle → one of four turns on the `Turn` code (which the
script holds while the turn clip's **root motion** rotates the body, then clears to `0` once the body has caught
the camera), and Jump layered over both. Every turn can also bail straight into Locomotion the instant you start
moving.

### Why the layering behaves

**A state machine only evaluates the transitions leaving the state it is currently in.** While in `Jump`,
nothing about Idle or Locomotion is even looked at, and every exit from `Jump` requires `Jumping is false`, so
mid-air the machine stays put until you land. The two speed-banded exits land you straight into Idle or
Locomotion without popping through a third state.

**The turn codes are a single parameter, one value each**, so `Turn eq 1 … eq -2` can never overlap — order
never matters. The script sets exactly one code at a time and clears it to `0` when done, which is the only
thing that lets a `Turn* → Idle` fire. If you start walking during a turn, `Speed > 0.1` yanks the machine into
Locomotion first (the script also cancels the turn on the same frame).

**Turn-in-place is animation-authoritative.** With Root motion enabled on the turn clips, the *animation*
rotates the body — the script only picks the clip (by the sign and size of the camera-vs-body angle) and clears
`turnRequest` once the body is within a few degrees of the aim. The amount the body turns is whatever the clip
was authored to turn, so a 90° clip that actually turns 80° leaves the character ~10° short, which is inside the
`turnThreshold` deadzone and reads fine. If a turn under- or over-shoots badly, fix it in the clip, not the
script.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | move, relative to where the camera is looking (W ahead, A/D strafe, S back) |
| `Left Shift` | sprint |
| `Space` | jump (only when grounded — no double jump; ~0.1s of coyote time) |
| mouse | look; click once to lock the pointer, or hold left-drag. Free to orbit while standing still. |
| wheel | zoom the camera between `minDistance` and `maxDistance` |

Every tunable is a public field, so it shows up in the node's **Variables** and can be changed per node
without touching the script (`turnThreshold`, `turnSpeed`, `directionSmoothing`, `walkSpeed`, `runSpeed`, …).
`turnSpeed` is how fast the body swings to the camera *while moving* (turn-in-place is the clip's job, not
this). `directionSmoothing` (seconds) damps how fast the blend-space Direction axis glides between strafes —
raise it for softer direction changes, drop it toward `0` for an instant snap.

## How they fit together

Facing lives on the **body** (the Playable). The world look direction is simply the Camera Rig's yaw. While you
hold a movement key, `ThirdPersonPlayable` turns the *body* toward that look direction and drives `node.velocity`
camera-relative on the horizontal plane, publishing the strafe angle (relative to the body's facing) as
`moveDir`. Let go and it stops turning the body, so the camera orbits a still character; swing past
`turnThreshold` and a **root-motion turn clip** rotates the body to catch up.

The body turning never disturbs the camera: a **Camera Rig** publishes its yaw as a *world* yaw and cancels its
parent's rotation every frame (`CameraRigNode._applyRigTransform`), so the aim you set with the mouse is held no
matter how the body spins underneath it. This is why the pivot must be a Camera Rig — a plain Empty parented to
the body would be dragged round with it. (Keep the rig's own local position centred on the body — head height,
no horizontal offset; put the shoulder offset on the rig's **Socket Offset** — so the body's yaw doesn't swing
the camera's position either.)

Jumping is gated on `node.isGrounded`, which the engine answers from the physics contacts. That covers terrain
and ordinary bodies alike, ignores trigger volumes, and follows whatever direction gravity currently points.
