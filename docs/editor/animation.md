# Animation

The Animation Editor, reached from a skinned model's **Animation** section in the inspector. It puts
the editor into animation mode: the scene tree becomes the model's **Skeleton**, and three panels —
Clips, Variables, State Machine — replace Properties.

The runtime API is in [Animation (scripting)](../scripting/animation.md).

## Clips

Lists the model's clips.

- **Rename** — renaming a linked clip renames it in its `.anim` asset, and every model using it
  follows.
- **Delete**.
- **Root motion** — a per-clip toggle between the clip's name and its ✕.
- **Import animation clips** — glTF, GLB or FBX, through the retargeting flow described in
  [Models and materials](models-and-materials.md#animation-import-and-retargeting).

Clips belong to the **model asset**, so every placement of that model inherits them.

### Root motion

Root motion lets the *animation* physically move the character — the body if it has one, otherwise
the model node — instead of returning it to where it started.

Turn it **on** for turn-in-place and other clips whose animation is authoritative. Leave it **off**
for locomotion driven by physics velocity, or the character double-moves. A blend-space state
ignores root motion entirely.

## Variables

Two lists.

**Parameters** — `float`, `bool`, `trigger`, `int`. Each is either set from script or **bound**:

| Binding | Reads |
|---|---|
| **Built-in** → Self / Parent / Scene | An engine-measured value: `planarSpeed`, `isGrounded`, `turnRate`, … |
| **Variable** → Self / Parent / Scene | A node variable. |

A bound parameter needs no script at all — the machine reads it every frame. The full built-in list
is in [Animation built-ins](../reference/animation-builtins.md).

> **Bind Speed to the built-in `planarSpeed`**, not to a script's intended speed. It is *measured*,
> so a character jammed against a wall reads 0 and drops to idle instead of running on the spot; it
> ignores falling, so a jump never reads as a sprint; and it lets a blend-space axis be in real
> world units.

**Events** — an event name, its clip, and a time you scrub by dragging a marker on the transport.
The event is delivered to `onAnimationEvent`. This is how a footstep, a hit frame or a particle
burst stays locked to the animation rather than to a timer.

## The state machine

Two views, switched with the **Animations | Graph** control.

### The graph

A node canvas. Drag states around, drag handle to handle to make a transition, right-click for a
menu, Delete to remove. Edges are labelled with a summary of their conditions. One state is the
**entry**, set from the right-click menu.

### The inspector

**A selected state:**

| Field | Meaning |
|---|---|
| **Name** | |
| **Source** | A **clip**, or an **animation field** (a blend space) with per-axis parameter bindings. |
| **Loop** | |
| **Play count** | |
| **Speed** or **speed parameter** | Playback rate. |
| **Foot-IK weight**, optionally from a parameter | How strongly foot IK applies in this state. |

**A selected transition:**

| Field | Meaning |
|---|---|
| **Has exit time** / **exit time** | Wait until the source clip reaches a point. |
| **Blend** | Cross-fade seconds, per transition. |
| **Minimum dwell** | Least time in the source state before this may fire. |
| **Conditions** | A tree of AND/OR groups over parameters. |

There is also a **Preview**: it simulates the machine and lets you drive parameters by hand, which
is far quicker than pressing Play to find out whether a transition can fire.

**Apply to Model** commits the machine (Ctrl+S on the tab does the same).

### The `±` band is not optional

Every `>` / `<` condition can carry a hysteresis band, and on anything measured you need it.

`Speed > 0.1` leaving Idle and `Speed < 0.1` leaving Locomotion are each obviously correct on their
own, and together they are the most common way to make a character vibrate: a speed hovering at
`0.1` satisfies both on alternating frames, so the machine flips state every frame and re-arms a
cross-fade from a pose that has barely moved. **It looks like a blend problem, and it is not.**

With `± 0.1`, `> 0.1` does not engage until `0.15` and `< 0.1` not until `0.05`. The editor flags a
`>` / `<` pair whose engage points do not separate, and the runtime logs
`Animation state machine is ping-ponging: …` naming the two states if one slips through.

Root motion sharpens this: a turn clip's root motion physically moves the character, which feeds
Speed, which is what the turn's exit reads. Without the band, an idle turn can trip its own exit.

## Blend spaces

An **animation field** (`.afield`) blends several clips by where a probe sits on a plot. Create one
from the model inspector or from **+ Add**; it opens in its own mode.

**Field Settings** (right): name, 1D or 2D, axis ranges and smoothing, and per-sample clip and rate
scale. **Blend Space** (bottom): the plot itself, with a draggable probe and a live preview.

### Authoring one

1. **Set the axes.** Each axis binds to a parameter and has a range. The editor normalizes each axis
   by its own min/max before any distance maths, so a `0…4` speed axis and a `−180…180` direction
   axis carry equal weight — you do not have to match their numeric scales.
2. **Place the clips** at their coordinates.
3. **Drag the probe** and watch the model. The weight read-out shows which clips are active.

A typical strafe set is eight samples — four directions × two gaits:

| Clip | Direction | Speed |
|---|---|---|
| walk / run forward | `0` | `1.5` / `4` |
| walk / run right | `−90` | `1.5` / `4` |
| walk / run left | `+90` | `1.5` / `4` |
| walk / run backward | `180` | `1.5` / `4` |

Remember the sign convention: **right is `−90`, left is `+90`**.

### Four things that go wrong

> **Turn on `wrap` for a heading axis.** It makes the axis a circle, so `−180` and `+180` are the
> same heading and a probe at `−170` is ten degrees from the backward clips rather than 350. Without
> it, crossing ±180 lurches through every clip on the way.

> **Do not also set a playback speed on a field state.** A field matches speed by *choosing clips*,
> not by playing one faster. Binding movement speed to both the field's axis and the state's rate
> multiplies it twice — the run plays 4× too fast and idle freezes. Switching a state to Field
> clears the rate for you; just do not re-add one.

> **Idle does not belong in the field.** A single idle sample at the origin loses to the nearest
> walk clip at zero speed, because the plot blends by distance — the character drifts into a strafe
> while standing still. A separate Idle state sidesteps it.

> **If a diagonal looks like the legs are fighting**, the two clips start at different points in the
> gait. Set **phase** to `0.5` on one of them. If instead the pose *buzzes*, it is the probe, not the
> clips — open the Preview, turn on simulation, and read the spread column to see which value is
> moving.

Diagonals are synthesized: with only four cardinal clips, a probe at 45° reads as a blend of its two
neighbours. Real diagonal clips sharpen it but are not required.

A clip that is much shorter than the field's median foot-slides; the panel flags it and sets a
**rate scale** in one click.

## Foot IK

An analytic two-bone solver that plants feet on uneven ground.

Author the rig in the **Skeleton** tree: select a joint — from the tree or by clicking it in the
viewport — and assign it a role, **Thigh / Shin / Foot / Toe**, per leg. There is a `⤓`
name-matched auto-guess and a validation report.

The rig is written to the **model asset**, so every placement inherits it. Per-state strength comes
from the state's foot-IK weight.

## Debugging

- The **Animation blend** debug overlay shows the live blend read-out, and works during Play.
- The **Skeletons** overlay draws joints and bones.
- The State Machine panel's **Preview** simulates without entering Play.
- Warnings flag oscillating transition pairs and unreachable ones.

## See also

[Animation (scripting)](../scripting/animation.md) · [Animation built-ins](../reference/animation-builtins.md) · [Third-person character](../../examples/scripts/README.md)
