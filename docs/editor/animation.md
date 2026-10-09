# Animation

Animation is authored in four places:

| Editor | Reached by | For |
|---|---|---|
| **State machine** | **Open State Machine** (or **Edit Controller**) in a skinned model's **Animation** section, or double-clicking a `.controller` | Clips, parameters, states, transitions, layers, action slots |
| **Rig** | Opening a `.rig` | The skeleton's [sockets](#sockets), [bone masks](#bone-masks) and [poses](#poses) |
| **Clip** | Opening a `.anim` | One clip's timeline, bone posing and [clip events](#events-on-the-clip) |
| **Animation Field** | Opening an `.afield` | A [blend space](#blend-spaces) |

In the state machine editor the scene tree becomes the model's **Skeleton**, and three panels —
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

Clips belong to the model's **rig**, so every character built on that skeleton inherits them.

### Root motion

Root motion lets the *animation* physically move the character — the body if it has one, otherwise
the model node — instead of returning it to where it started.

Turn it **on** for turn-in-place and other clips whose animation is authoritative. Leave it **off**
for locomotion driven by physics velocity, or the character double-moves. A blend-space state
ignores root motion entirely, and only the base layer applies it — never a layer or an action.

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
burst stays locked to the animation rather than to a timer. These markers belong to *this* machine;
a marker that should fire wherever the clip plays belongs [on the clip](#events-on-the-clip).

**Action slots** — named places a script plays one-shots into. See [Action slots](#action-slots).

## The state machine

Two views, switched with the **Animations | Graph** control.

### The graph

A node canvas. Drag states around, drag handle to handle to make a transition, right-click for a
menu, Delete to remove. Edges are labelled with a summary of their conditions. One state is the
**entry**, set from the right-click menu.

The toolbar carries a tab strip — **Base | *layer* … | + Layer** — that picks which
[layer](#layers-and-bone-masks) the canvas shows. The highlighted state is that layer's current one.

### The inspector

**A selected state:**

| Field | Meaning |
|---|---|
| **Name** | |
| **Plays** | **Clip**; **Field** — an animation field (a blend space) with per-axis parameter bindings; or **Pose** — a static pose from a [pose asset](#poses). |
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

**Apply State Machine** commits the machine onto the node it was opened from (Ctrl+S on the tab does the same).
When the machine comes from a [controller](#animation-controllers) the button reads
**Apply to Controller** and writes the controller asset instead.

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

## Animation Controllers

A **controller** (`.controller`) is a state machine as a shareable asset — parameters, states,
transitions, layers and action slots — the way Unity's Animator Controller or Unreal's Animation
Blueprint is. One zombie controller can drive every zombie.

Make one either way:

- **Assets → + Add → Animation Controller** creates an empty one.
- **Save as Controller…**, at the top of the state machine editor's panels, turns the machine you
  are editing into one. **Apply** afterwards links the character to it.

Double-click a controller to open it in the state machine editor. It is previewed on a character
built on its rig; with no such model in the project it does not open, and the log says why.

### Using one on a character

A character runs either its **own state machine** or a **controller**, picked at the top of its
**Animation** section in the inspector.

| Control | Does |
|---|---|
| **Own state machine** / **Controller: *name*** | Which machine the character runs. Controllers on the character's rig are offered, plus any with no rig. |
| **Open State Machine** / **Edit Controller** | Opens the editor on it. |
| **Clip overrides (this character only)** | Every clip the controller plays, each with an optional replacement. A crawler on the shared zombie controller can swap its Walk for a crawl. This is Unity's Override Controller. |

While editing a linked character, the bar above **Apply** names the controller.
**Apply to Controller** writes the asset, and **every character using it updates**. **Detach** stops
following the controller: on the next Apply the character keeps the machine as its own.

> A character holds a resolved copy of its controller — that is what plays, and what ships in a
> template, a bundle or a published game. Deleting a controller therefore leaves every character
> running the machine it last copied; it just stops tracking the asset.

## Layers and bone masks

A machine can have **layers** above the base. Each layer runs its own states and transitions over
the **same parameters**, and is blended on top of everything beneath it — the legs keep walking on
the base while an upper-body layer aims, waves or holds a torch.

Add one with **+ Layer** on the graph toolbar, then pick its tab to edit its states. Its settings are
the **Layer** section at the top of the State Machine panel:

| Field | Meaning |
|---|---|
| **Name** | What scripts address it by. ✕ deletes the layer and its states. |
| **Blend** | **Override** replaces the pose beneath, by weight × mask. **Additive** adds the clip's motion *relative to its own first frame* on top — breathing, recoil, a flinch. |
| **Weight** | `0`–`1` from the slider, or **param…** to read it from a parameter every frame. |
| **Mask** | A [bone mask](#bone-masks), or **Whole body**. |

Three rules worth knowing:

- **An empty state adds nothing.** A state with no clip on a layer means "this layer is off": the
  layer fades out while it is there, and fades back in when it leaves. That is how an upper-body
  layer gets out of the way.
- **Only the base layer drives root motion.** Two layers both moving the character would double it.
- **A deleted mask switches its layer off**, rather than letting it cover the whole body.

### Bone masks

A **bone mask** (`.mask`) says which bones a layer or an [action slot](#action-slots) may move, and
how strongly. Masks are made and edited in the **rig editor**, in its **Bone Masks** section, against
that rig's skeleton:

- **+ New mask…** starts from a preset — **Upper body**, **Lower body**, **Left arm**, **Right arm**,
  **Head**, found by bone names — or **Empty**.
- Expand a mask to see the skeleton with a checkbox per bone. **Click** a bone to include its whole
  branch (tick the spine and the upper body follows); **Alt-click** to toggle that one bone alone.
- An included bone has a **weight**, `0`–`1`: how strongly it follows the layer.

Masks store bones by **name**, so a re-export cannot repoint them. An edit reaches every character
using the mask without a re-Apply.

## Poses

A **pose asset** (`.pose`) holds named static poses of one skeleton, each a set of per-bone changes
from rest — a hand grip, a pointing finger, an injured stance. It is Unreal's Pose Asset.

**Authoring.** In the clip editor's Bone panel, pose some bones and use **Save N posed bones as a
shared pose…**. The pose goes into the rig's pose asset, which is created for you if the rig has none.

**Managing.** The rig editor's **Poses** section lists the rig's pose assets: rename them, rename or
delete individual poses, or **+ New pose asset**. Clips and states refer to a pose by id, so a rename
breaks nothing.

**Using.** A pose can be

- layered onto a clip as a pose-offset edit, as before; or
- held by a state: set **Plays** to **Pose** and pick it. On a masked layer, that is a hand closing
  around a weapon while the rest of the body keeps moving.

> Older projects stored poses on the rig itself. Those keep working, and the Poses section offers
> **Move into a pose asset**, which keeps every pose id so no clip referencing one breaks.

## Action slots

An **action** is a one-shot a script plays over whatever the machine is doing — an attack, a reload,
a wave — with no graph wiring at all. It fades in, plays, and fades out by itself; a second action in
the same slot cross-fades from the first. Unreal calls this a montage slot.

Slots are declared on the machine, in the Variables panel's **Action slots** section:

| Field | Meaning |
|---|---|
| **Name** | What `playAction` asks for. |
| **Above** | Which layer the slot sits on top of — **Base** or any layer. |
| **Mask** | A bone mask, or **Whole body**. An `UpperBody` slot keeps the legs on locomotion. |
| **Blend** | Override or Additive, as for a layer. |

With **no** slots declared, an action plays full-body over everything. The script side is
[`animator.playAction`](../scripting/animation.md#actions).

## Events on the clip

An event marker can belong to the **clip** itself, and then it fires wherever that clip plays — a
base state, a layer or an action slot — through the same `onAnimationEvent(name, clip)` handler.

They are authored on the clip editor's timeline, in the row above the bone keys:

- **+ Event at playhead** adds one and asks for its name.
- **Drag** a marker to move it, **click** it to rename, **double-click** it to delete.

The machine's own **Events** list (in Variables) still works. Prefer the clip's for anything that is
a fact about the animation — a footstep, a contact frame — so every machine that plays it gets it.

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

## Sockets

A **socket** is a named attach point on a bone — where a sword, a torch or a hat is held. Sockets are
a property of the skeleton, so they live on the **rig**, and every character built on it gets the
same `RightHand`.

### On the rig

The rig editor's **Sockets** section:

- **+ Add socket on *bone*** adds one on the bone selected in the Skeleton panel, named after it.
- Expand a socket to change its **name**, its **bone**, and its offset from the bone: **Position**
  (metres), **Rotation** (degrees) and **Scale**. The viewport gizmo drags the same offset.
- **Preview model** shows a model on the socket in the animation editors — rig, clip, state machine
  and animation field — so a sword can be checked against a swing. It is never placed in a scene.

A socket's scale ignores the **bone's** own scale. An FBX armature sits under a `0.01` scale, and a
socket that inherited it would shrink a held sword to a centimetre; the scale comes from the socket's
offset only.

Sockets are written into the skin of every model on the rig, so they travel with it into templates,
bundles and the published game. Renaming a socket detaches anything using the old name; deleting one
leaves its followers where they were.

### Attaching a node

Any node can follow a socket, from the **Attach to socket** section of its inspector:

| Field | Meaning |
|---|---|
| Target | **Nearest character above** (the default), or a specific character in the scene. |
| Socket | Which socket, or **Not attached**. |

"Nearest character above" walks up from the node and, at each ancestor, also looks down into it — a
character is usually a holder node with its mesh beneath it, so a weapon dropped under the holder is
the mesh's sibling, not its child.

> **While attached, the node's transform is overwritten every frame**, in the editor too. Move it by
> editing the socket's offset, not the node.

The follow runs after animation and before camera rigs, so a held item never trails the hand by a
frame, and a camera following it sees it where the hand put it.

## Debugging

- The **Animation blend** debug overlay shows the live blend read-out, and works during Play.
- The **Skeletons** overlay draws joints and bones.
- The State Machine panel's **Preview** simulates without entering Play.
- Warnings flag oscillating transition pairs and unreachable ones.
- On a layer's tab, the graph highlights that layer's current state.

## See also

[Animation (scripting)](../scripting/animation.md) · [Animation built-ins](../reference/animation-builtins.md) · [Third-person character](../../examples/scripts/README.md)
