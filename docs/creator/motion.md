# Motion Creator

Animate a character from a few key poses. You pose the mannequin, put the poses on a timeline with a
blend curve into each, and the Creator works out everything in between. It adds overlapping action and a little
life, and plants hands and feet with IK. Each body part can arrive at a pose its own way: the legs
straight while the arms spring. The result is an ordinary clip, so the Editor plays and retargets it like
any imported animation.

The approach is the one David Rosen described for Overgrowth (GDC 2014): a handful of poses per motion,
with code doing the in-betweening.

The subject is the Editor's **mannequin**, which has Mixamo bone names. Every humanoid in a project that
retargets from it, such as the Valley's knights, can play what you make here. To animate your own rigged
model instead, add it as a [character](#characters).

Clip events (a `hit`, a `footstep`) are not made here: they belong to the clip, and the Editor's clip
player sets them. They survive every change you make to the motion afterwards.

## Poses

The left dock lists the poses, in two groups. Click one to select it and hold it in the viewport; drag one
onto the Timeline to add a key with it.

### This motion

The motion's poses. A pose marked with a chain link (*library* in its caption) is a [library pose](#library) the motion
uses: editing it edits the library pose, and every motion that uses it follows.

| Button | Does |
|---|---|
| **New** | A pose at rest. |
| **Duplicate** | A copy of the selected pose, to change into the next one. The copy is the motion's own. |
| **Mirror** | The selected pose with left and right swapped: a left-foot-forward stride becomes the right-foot one. Arms and legs swap, and the spine, neck and head turn the other way. The hips offset and IK goals reflect with it. |
| **Rename** | Rename the selected pose. A library pose is renamed in the library. |
| **Delete** | Remove the selected pose from the motion, and the keys that use it. A library pose stays in the library. |
| **Save to library** | Keep the selected pose in the library, for every motion on this character. The motion then uses it from there. |
| **Make local** | Stop following the library: the motion keeps its copy of the pose as its own. |

### Library

The library's poses for the motion's subject: the mannequin's, or the character's. They are **Pose assets**
in the shared library, under `/Poses` in **Assets**, and they reach the Editor as Pose assets. Click one to
edit it in the Pose tab, even when the motion does not use it; drag it onto the Timeline, or **Use in
motion**, to use it. **Rename** and **Delete** act on the library: a motion that used a deleted pose keeps
its copy, as a pose of its own.

Opening a Pose asset from **Assets** switches to its character and edits it.

## Pose

The **Pose** tab edits the selected pose (*Library pose* in its header when it is one).

**Bones** — the humanoid bones grouped by body part. **Every bone** lists the rest of the joints, such as
fingers and twist bones. Bones the pose changes are marked *posed*.

**Rotation** — the selected bone's turn from rest, in degrees about its own X, Y and Z axes: exact numbers
for what the viewport does by hand. For the hips, **Move X/Y/Z** shifts the whole body in metres.
**Reset bone** puts the bone back at rest.

**IK** — use this to plant a hand or a foot: the limb bends to reach its goal and stays there while the
body moves. **Plant** fixes a goal where the limb is now; the sliders then move the goal, and the arm or leg
bends to reach it. A goal stays where it is while the body moves over it, so a planted foot does not slide.
That is the point of using IK for steps and for hands on a ledge. **Release** lets the limb go back to its
rotations.

A planted goal has three more options:
- **Hold rotation** — the hand or foot keeps the turn you give it (the **Turn** sliders), however the arm
  or leg bends: a blade held at one angle, a foot flat on the floor. The rotate rings on a planted hand
  turn this.
- **Point the elbow** / **Point the knee** — the middle joint bends toward this point. Use it to open the
  elbows out to the sides, or to turn a knee over the toes.
- **Grip with the other hand** — for a two-handed weapon. The hand holds on to the other one where it is
  now, and rides it on every frame of the clip, between the keys too, so the hands never come apart.
  Move or turn either hand and the grip moves with it; the **Grip** sliders shift the hold.

### Viewport

The quickest way to pose is in the viewport, on the skeleton drawn over the character:

| Do | What happens |
|---|---|
| **Click a joint** | Selects its bone: the Pose tab shows it, and the rotate rings appear on it. (With the Parts tab showing, it adds the bone to the selected part instead: see [Parts](#parts).) |
| **Drag a joint** | The bones above it bend so it follows the cursor, in the plane facing the camera. A hand bends the arm, a foot the leg, the head the neck. |
| **Drag a ring** | Turns the selected bone about that axis; the outer ring turns it about the view. Use it for twists. |
| **Drag the hips** | Moves the whole body: crouch, lean or step. |
| **Drag a planted hand or foot** | Moves its IK goal. |
| **Esc** while dragging | Puts the pose back as it was. |

The controls top-right of the viewport, in Pose view, set how a drag works:
- **Keep lengths** — on, the bones bend and keep their length. Off, the joint goes exactly where you drag
  it and the bone above it stretches: squash and stretch. The stretch is part of the pose, baked as
  translation keys, and reaches the Editor with it.
- **Chain** — how many bones above the dragged joint bend: **auto** is two for a hand, a foot or the head
  and one elsewhere.

### Stage

The **Stage** menu, top-right of the viewport, sets up the preview; none of it reaches the clip.
- **Show** — what the viewport draws: the three switches below.
- **Grid** — the floor grid.
- **Floor** — the ground plane the character stands on.
- **Skeleton** — the joints and bones. Joints can be picked only while it shows.
- **Sun** — **Direction** turns the sun around the character, **Elevation** raises it.

A model authored in centimetres is shown at a hundredth, so it stands at a human height; poses and the
baked clip stay in the model's own units.

## Parts

The **Parts** tab groups the bones into body parts that each arrive at a pose their own way. A new motion
starts with **Body**, **Left arm**, **Right arm**, **Left leg** and **Right leg**: every joint goes with its
nearest humanoid bone, so the fingers follow their hand and the toes their foot. Until a part is given a
blend of its own it follows the keys' blends exactly, and the clip is the same as with no parts at all.

**Parts** — the list. Click one to select it; the swatch sets its lane colour on the Timeline; **✎**
renames it and **✕** deletes it (its bones follow the keys' blends again). **+ Part** adds an empty part;
**Reset to defaults** brings back the five default parts and drops every key's overrides of parts.

**Membership** — the selected part's bones, grouped as in the Pose tab (**Every bone** for the rest).
Switch a bone on to move it into the part: a bone belongs to one part at most. While this tab shows,
clicking a joint in the viewport does the same.

**Defaults** — how the part arrives at every key, unless a key overrides it:

| Field | Meaning |
|---|---|
| **Curve** | The blend curve the part follows into each key, instead of the key's own: the legs **Linear** while the arms **Spring**. |
| **Offset** | Seconds the part arrives late (positive) or early (negative) against every key: the arms a beat behind the body. A one-shot clip plays on until a late part has arrived. |
| **Overlap** | The part's own overlapping action, in seconds per joint, instead of the motion's (**Feel ▸ Overlap**). |
| **Life** | How much of the motion's **Variation** the part takes: 0 holds it exactly still, 2 doubles it. |

A field shown dim is inherited; **↺** beside one that is set inherits again.

## Timeline

The **Timeline** tab, under the viewport beside Assets and the Console, lays the motion out in time. The
row of chips (**Keys**) is the poses, one per key. Under them, **Base** is the **blend** into each pose: the
curve the Creator follows from the previous pose to the arriving one. The curve's bottom line is the
previous pose and its top line the arriving one, so the motion's shape reads at a glance. A flat line with
a step is a hold, a bump over the top line is an overshoot, and a wobble is a spring. While the motion
plays, a dot rides the curve.

Below Base is one lane per part, in its colour: the curve that part follows into each key, moved by its
offset. A key's own override of the part draws solid; a blend the part inherits draws faded. Click a lane
segment to edit it in the key's **Parts** section; click a lane's name to select the part.

| Do | How |
|---|---|
| **Play** | **Play** in the Timeline, or **Space**. The preview loops. |
| **Loop** | Bakes the clip to loop: set the last key to the first pose. |
| **Scrub** | Drag on the ruler. |
| **Select a key** | Click its chip. The stage holds its pose, and the Pose tab edits it. |
| **Retime** | Drag a chip. Keys snap to frames; the first key stays at 0. |
| **Add a key** | Double-click the track (the selected pose), drag a pose from the Poses list onto it, or **+ Key** (at the playhead). A library pose dropped on it joins the motion's poses. |
| **Delete a key** | **Delete**, or **Delete** in the Key section. |
| **Zoom** | **Ctrl + wheel**, **−** / **+**, or **Fit**. |

The shaded part of the ruler past the last key is the overlap tail: the trailing joints still arriving.

### Key

The selected key's **Pose** and its **Time** in seconds.

### Blend

How the motion arrives at the selected key from the one before. Click a blend on the Base lane, or select
its key. Pick a **Preset**, then shape it:

| Preset | Feels like |
|---|---|
| **Linear** | Mechanical, constant speed. |
| **Ease in-out** | The default: starts and stops softly. |
| **Ease in** | Accelerates into the pose, as in a strike landing. |
| **Ease out** | Leaves fast and settles. |
| **Cubic** | A stronger ease in-out: a slow start, a fast middle and a soft stop. |
| **Anticipate** | Winds up away from the pose before moving into it. |
| **Overshoot** | Goes a little past the pose and comes back. |
| **Spring** | Swings past the pose and settles in a few wobbles. |
| **Bouncy spring** | More swings, less damping. |
| **Hold (snap)** | Stays on the previous pose and snaps at the key. |

Each kind edits its own way:
- **Curves (bezier)** — drag the two handles. A handle above the top line makes the motion overshoot, and
  one below the bottom line makes it wind up first.
- **Springs** — **Swings** is how many times it swings across the blend; **Damping** is how fast it settles.
- **Free-form** — turns any curve into keys to draw by hand: drag a key, double-click to add or remove one.

An edited curve shows as **Custom**. **Save as preset…** keeps it, by name, for every motion; it then
appears under **Saved** in the preset list. **Apply to all** gives every blend of the motion this curve.
**Delete preset** removes a saved preset; blends that use it keep their curve.

### Parts in a key

The key's **Parts** section: how one part (**Part**) arrives at this key. **Override** gives the part a
blend of its own for this key only — its **Curve**, **Offset**, **Overlap** and **Life**, the same fields
as the part's [defaults](#parts) — and off, the part inherits again. The first key has no blend into it,
so it overrides only the timing. **Apply to all** gives every key this override of the part.

## Motion

The **Motion** tab holds what shapes the whole clip.

**Feel** — how the motion moves between the keys:
- **Overlap** — each joint further from the hips trails by this many seconds, so the body leads and the
  head and hands follow. A one-shot clip runs a little past its last key so every joint arrives.
- **Variation** — a seeded drift on the spine, neck, head and arms, so a held pose looks alive.
- **Variation rate** — how fast the variation drifts.
- **Seed** — picks another take of the variation.

**Clip** — its **Frames per second**. **Download .anim** (toolbar) writes `<name>.anim.json`, which holds
the clip and the skeleton it was made on, and a `.motion.json` sidecar that regenerates it, both named
after the asset (`untitled` on Scratch). **Assets ▸ Import** reads a `.motion.json` back as a new motion,
to edit it again.

## Characters

**Assets ▸ + Add ▸ Rigged character…** uploads a rigged model: an `.fbx`, `.glb` or `.gltf`, with its
`.bin` and textures when it has separate ones. It is stored in the shared library under `/Characters`, and
the Motion Creator opens on it. The model needs a skeleton; a file without one is refused.
Every part of the model shows: the skinned meshes with their material maps (an FBX's embedded textures
included), and the parts that are not skinned, such as eyes, hair, armour or a held prop. Those move with
the bone they hang from.

The **Character** select in the toolbar picks what the motion animates: the **Mannequin**, or any
character in the library. The motion remembers its choice, and its poses, bones and baked clip use that
character's skeleton. Bones are found by their Mixamo-style names, so a humanoid with other names shows
them under **Every bone**. A motion whose character has left the library plays on the mannequin.

A character's poses are [library poses](#library) for it. (A character saved by an older Creator kept a
pose list of its own: the first time it opens, each of those poses becomes a library pose.)

### Clips

With a character selected, the left dock lists the clips the uploaded file carries. Click one to play it
on the stage.

| Control | Does |
|---|---|
| **Click** | Preview the clip. **Frame (s)** scrubs it. |
| **Rename** | The name the clip has in the Editor. |
| **● / ◌** | Hide the clip: it stays here but is not sent to the Editor. |
| **Delete** | Remove the clip from the character. The uploaded file keeps it. |
| **Pose from frame** | The clip at the current frame becomes a new pose in the motion, ready to edit. |

## In the Editor

**Save as asset** keeps the motion in the shared library. Every change then reaches each project's
`/Creator/Motion` folder as an animation asset on the mannequin's rig. The rig is reused when the project
already has it, and added when it does not. The clip is linked to the rig, so every model on that rig, or
retargeted from it, lists the clip. Use it from an animator state, an action slot or a blend space like any
other. Its events are set there, in the clip player, and kept when the motion changes.

Library poses reach every project's `/Creator/Poses` folder as Pose assets on their subject's rig, the IK
goals solved into the bones' rotations. Editing one here re-bakes every motion on this character that uses
it, and both reach the Editor.

A character reaches every project's `/Creator/Characters/<name>` folder by itself, with no save step. Its
visible clips become one animation asset each, on the rig of its skeleton. Hiding or deleting a clip
removes its asset, unless something in the project uses it. The model itself is not imported: add it to a
project with the Editor's **+ Add**, and it plays the clips.
