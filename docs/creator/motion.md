# Motion Creator

Animate a character from a few key poses. You pose the mannequin, put the poses on a timeline with a
blend curve into each, and the Creator works out everything in between. It adds overlapping action and a little
life, and plants hands and feet with IK. The result is an ordinary clip, so the Editor plays, retargets and
edits it like any imported animation.

The approach is the one David Rosen described for Overgrowth (GDC 2014): a handful of poses per motion,
with code doing the in-betweening.

The subject is the Editor's **mannequin**, which has Mixamo bone names. Every humanoid in a project that
retargets from it, such as the Valley's knights, can play what you make here. To animate your own rigged
model instead, add it as a [character](#characters).

## Poses

The left dock lists the motion's poses. Click one to select it and hold it in the viewport.

| Button | Does |
|---|---|
| **Duplicate** | A copy of the selected pose, to change into the next one. |
| **Mirror** | The selected pose with left and right swapped: a left-foot-forward stride becomes the right-foot one. Arms and legs swap, and the spine, neck and head turn the other way. The hips offset and IK goals reflect with it. |
| **New** | A pose at rest. |
| **Rename** | Rename the selected pose. |
| **Delete** | Remove the selected pose and the keys that use it. |

## Pose

The **Pose** tab edits the selected pose.

**Bones** — the humanoid bones grouped by body part. **Every bone** lists the rest of the joints, such as
fingers and twist bones. Bones the pose changes are marked *posed*.

**Rotation** — the selected bone's turn from rest, in degrees about its own X, Y and Z axes: exact numbers
for what the viewport does by hand. For the hips, **Move X/Y/Z** shifts the whole body in metres.
**Reset bone** puts the bone back at rest.

**IK** — use this to plant a hand or a foot. **Plant** fixes a goal where the limb is now; the sliders then
move the goal, and the arm or leg bends to reach it. A goal stays where it is while the body moves over it,
so a planted foot does not slide. That is the point of using IK for steps and for hands on a ledge.
**Release** lets the limb go back to its rotations.

### Viewport

The quickest way to pose is in the viewport, on the skeleton drawn over the character:

| Do | What happens |
|---|---|
| **Click a joint** | Selects its bone: the Pose tab shows it, and the rotate rings appear on it. |
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

The visibility menu (the eye) shows or hides:
- **Grid** — the floor grid.
- **Floor** — the ground plane the character stands on.
- **Skeleton** — the joints and bones. Joints can be picked only while it shows.

A model authored in centimetres is shown at a hundredth, so it stands at a human height; poses and the
baked clip stay in the model's own units.

## Timeline

The **Timeline** tab, under the viewport beside Assets and the Console, lays the motion out in time. The
row of chips is the poses, one per key. Under them is the **blend** into each pose: the curve the Creator
follows from the previous pose to the arriving one. The curve's bottom line is the previous pose and its
top line the arriving one, so the motion's shape reads at a glance. A flat line with a step is a hold, a
bump over the top line is an overshoot, and a wobble is a spring. While the motion plays, a dot rides the
curve.

| Do | How |
|---|---|
| **Play** | **Play** in the Timeline or the toolbar, or **Space**. The preview loops. |
| **Scrub** | Drag on the ruler. |
| **Select a key** | Click its chip. The stage holds its pose, and the Pose tab edits it. |
| **Retime** | Drag a chip. Keys snap to frames; the first key stays at 0. |
| **Add a key** | Double-click the track (the selected pose), drag a pose from the Poses list onto it, or **+ Key** (at the playhead). |
| **Delete a key** | **Delete**, or **Delete** in the Key section. |
| **Zoom** | **Ctrl + wheel**, **−** / **+**, or **Fit**. |

The shaded part of the ruler past the last key is the overlap tail: the trailing joints still arriving.

### Key

The selected key's **Pose**, its **Time** in seconds, and its **Event**: a clip event fired when the clip
reaches the key, such as `hit` or `footstep`. A script receives it in `onAnimationEvent`.

### Blend

How the motion arrives at the selected key from the one before. Click a blend on the lane, or select its
key. Pick a **Preset**, then shape it:

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

## Motion

The **Motion** tab holds what shapes the whole clip.

**Feel** — how the motion moves between the keys:
- **Overlap** — each joint further from the hips trails by this many seconds, so the body leads and the
  head and hands follow. A one-shot clip runs a little past its last key so every joint arrives.
- **Variation** — a seeded drift on the spine, neck, head and arms, so a held pose looks alive.
- **Variation rate** — how fast the variation drifts.
- **Seed** — picks another take of the variation.

**Clip** — the clip's **Name**, its **Frames per second**, and **Loop**. With Loop on, set the last key to
the first pose. **Download .anim** writes `<name>.anim.json`, which holds the clip and the skeleton it was
made on, and a `.motion.json` sidecar that regenerates it.

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
them under **Every bone**.

With a character selected, the left dock adds two sections above the poses.

### Clips

The clips the uploaded file carries. Click one to play it on the stage.

| Control | Does |
|---|---|
| **Click** | Preview the clip. **Frame (s)** scrubs it. |
| **Rename** | The name the clip has in the Editor. |
| **● / ◌** | Hide the clip: it stays here but is not sent to the Editor. |
| **Delete** | Remove the clip from the character. The uploaded file keeps it. |
| **Pose from frame** | The clip at the current frame becomes a new pose in the motion, ready to edit. |

### Character poses

A pose library kept with the character, for every motion made on it. **Save “pose” to character** stores
the selected motion pose. Click a saved pose to add a copy to the motion. Rename and delete them here.

## In the Editor

**Save as asset** keeps the motion in the shared library. Every change then reaches each project's
`/Creator/Motion` folder as an animation asset on the mannequin's rig. The rig is reused when the project
already has it, and added when it does not. The clip is linked to the rig, so every model on that rig, or
retargeted from it, lists the clip. Use it from an animator state, an action slot or a blend space like any
other.

A character reaches every project's `/Creator/Characters/<name>` folder by itself, with no save step. Its
visible clips become one animation asset each, and its pose library becomes a Pose asset, all on the rig
of its skeleton. Hiding or deleting a clip removes its asset, unless something in the project uses it. The
model itself is not imported: add it to a project with the Editor's **+ Add**, and it plays the clips.
