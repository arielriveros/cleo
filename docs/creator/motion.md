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

To animate over filmed action, link a video as the motion's [reference](#reference): it plays with the
motion, frame for frame.

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
| **Play** | The [transport](#transport)'s play button, or **Space**. |
| **Scrub** | Drag on the ruler. |
| **Select a key** | Click its chip. The stage holds its pose, the Pose tab edits it, and the playhead moves to it, so a reference video shows that key's frame. |
| **Retime** | Drag a chip. Keys snap to frames (a reference video's own frames, when it has them); the first key stays at 0. |
| **Add a key** | Double-click the track (the selected pose), drag a pose from the Poses list onto it, or **+ Key** (at the playhead). A library pose dropped on it joins the motion's poses. |
| **Delete a key** | **Delete**, or **Delete** in the Key section. |
| **Zoom** | **Ctrl + wheel**, **−** / **+**, or **Fit**. |

The shaded part of the ruler past the last key is the overlap tail: the trailing joints still arriving.

With a [reference](#reference), the **Video** lane under the ruler lays the clip along the motion: a strip of
its frames and, under them, its sound. Footsteps and impacts show as spikes, often the quickest way to time a
contact. Drag the strip to slide the video along the motion; drag either end to trim it. The timeline runs
to the end of the video when it is longer than the motion: past the clip's last frame the character holds
its last pose, or cycles when the motion loops.

Once the clip is [analysed](#analysis), the **Motion energy** lane under it draws how much the subject
changes from frame to frame: the curve dips where the action holds or turns. A yellow mark at a dip is a
key-pose candidate (click it to go there), a shaded stretch is held frames, and a red line is a cut. With
[tracks](#tracking), a tracked foot's contacts show along its bottom in the track's colour, and a dot at the
top marks where a tracked hand or head turns (click it to go there).

### Transport

The row at the top of the Timeline plays the motion. Left to right:

| Button | Does | Key |
|---|---|---|
| **To the start** | The first frame (of the loop range, when one is set). | **Home** |
| **Back one frame** | One frame back: the reference video's own frame, else one at the bake rate. **Shift** goes ten. | **,** or **←** |
| **Play / Pause** | Plays the motion, the video with it. | **Space** |
| **Forward one frame** | One frame on. **Shift** goes ten. | **.** or **→** |
| **To the end** | The last frame. | **End** |
| **Loop** | Playback wraps at the end; off, it stops there. | |
| **Speed** | 0.1× to 2×: slow it down to read a fast action. | |

**J**, **K** and **L** shuttle: **L** plays forwards and doubles the speed with each press, **J** does the same
backwards, and **K** stops. **I** and **O** set a loop range at the playhead (its start and end); the range
shows under the ruler, and its button beside the transport plays the whole timeline again.

The timecode is minutes, seconds and the frame within the second. With a reference, the video's own frame
number follows it.

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

**Clip** — its **Frames per second**: a common rate, the NTSC ones included (23.976, 29.97, 59.94), or any
rate from 10 to 240. **Loop** bakes the clip to loop: set the last key to the first pose. **File ▸ Download
.anim** writes `<name>.anim.json`, which holds
the clip and the skeleton it was made on, and a `.motion.json` sidecar that regenerates it, both named
after the asset (`untitled` on Scratch). **Assets ▸ Import** reads a `.motion.json` back as a new motion,
to edit it again.

## Reference

The **Reference** tab links a video to the motion, to animate over filmed action: a person or an animal
doing the move, a phone clip, a slow-motion take. The video plays with the motion frame for frame, over the
3D view or behind the character, and the stage's camera can be set up as the one that filmed it, so the
character stands in the footage's perspective. Step to the frame where the action turns, make a key there,
and pose the character to match.

The clip is kept in the library, under **/Video**; it stays in the Creator and is never sent to the Editor.
A motion keeps only which clip it uses and how its time lines up.

### Video

**Load video…** adds a file: an `.mp4`, `.mov`, `.mkv` or `.webm` whose video the browser can decode (H.264,
HEVC where the graphics card has it, VP8, VP9 or AV1; not ProRes or DNxHD). Its size, frame rate, length and
codec show under its name. **From the library…** uses a clip already there; **Assets ▸ + Add ▸ Video
reference…** and **Assets ▸ Import** add one too, and opening a clip in the Assets tab links it to the open
motion. **Replace…** links another file and **Unlink** stops using one (the clip stays in the library).

The first time a clip is opened its frames are read (where each one falls in time), and the Timeline's
thumbnails and sound are made and kept with it.

A phone often records at a **variable frame rate**: its frames are unevenly spaced. The tab says so, and
every frame is then placed at its own time, so stepping and snapping still land on real frames.

### Timing

How the video's time lines up with the motion's. The motion's timeline is real time.

- **Filmed at** — the rate the camera filmed at. It is the file's rate for ordinary footage; for slow motion
  it is higher (a phone's 240 fps clip is stored at 30). The motion then runs at real speed, and a slow-motion
  clip lies stretched out on the Timeline. **Real speed** sets it back to the file's rate.
- **Offset** — the video's time at the motion's start. **Start here** makes the frame at the playhead start
  the motion. Dragging the Video lane does the same thing by hand.
- **In · out** — the stretch of the video used, in its own seconds. **Trim here** moves the nearer end to the
  playhead. Dragging the lane's ends does it by hand.
- **Motion** — the motion's bake rate. **Match video** bakes the motion at the video's real-time rate (the
  rate it was filmed at), so every frame of the footage has a frame of the clip.
- **Keys snap to the video's frames** — keys dragged on the Timeline, and the transport's frame steps, land on
  the video's own frames; off, on the bake rate's.

### Display

How the video is drawn in the viewport:
- **Off** hides it; **Over** draws it over the 3D view, see-through, at its **Opacity**.
- **Behind** draws it behind the character, wherever nothing else is: the floor is hidden, the grid and the
  skeleton stay on top. With [Look through](#camera) the character then stands in the footage.
- **Difference** draws the difference of the two pictures instead: where the character covers the filmed
  body exactly it goes dark, so a pose can be matched by making the silhouette disappear.
- **Mirror** flips it left to right, for footage of the other side.
- **Film gate** darkens the viewport outside the video's frame.
- **Sound** plays the video's sound while the motion plays forwards at up to twice real speed.
- **Decode at** — the width the video is decoded at for the viewport. A smaller size plays a 4K clip smoothly.

The video is always shown whole, as large as fits the viewport.

### Analysis

**Analyze** reads the whole clip in the background, frame by frame at a small size, and keeps what it
finds with the clip. It uses no AI: every step is ordinary image arithmetic, so what it finds can be
checked by eye.

- **Key poses** — the subject's motion energy (how much its pixels change from the frame before) falls
  where the action holds or turns: a contact, an extreme, the top of a jump. Its dips, ranked by how deep
  they are against the curve around them and kept a little apart, are the **key candidates**. **Key
  sensitivity** offers fewer, surer ones or more. **Add keys at candidates** makes a key at each, with a pose
  from the motion there, ready to pose against its frame.
- **Held frames** — a frame no different from the one before. When most of the clip holds every other
  frame the tab says **animated on twos** (or threes): the drawings change at half the frame rate.
- **Cuts** — a jump in the frame's brightness histogram far beyond the clip's usual change: a shot
  change, where the clip probably wants trimming.
- **Subject** — with a still camera, the empty scene is each pixel's median over many frames (anything
  that moves covers a pixel in fewer than half of them), worked out per shot. What differs from it, in
  brightness or colour, cleaned of specks and holes, is the moving subject, and its largest region its box.
  **Show its box** outlines it over the video. **Crop** zooms the Over display onto it: **Subject** onto
  everywhere it goes (a still crop), **Follow** onto it frame by frame (the same size throughout, so it never
  pumps). Looking through the camera and Behind always show the whole frame.

A clip filmed with a moving camera has no still background: the tab warns that the subject's box is then
unreliable. The key candidates still come from the whole frame's energy.

### Tracking

Follows points through the clip: a foot, a hand, the head, anything with a little texture. No AI here
either: each point's small window is matched from frame to frame by the Lucas–Kanade method, coarse to
fine, and every step is checked by tracking back to where it came from. A point that does not come back
(hidden behind a leg, blurred) is lost there rather than guessed on.

- **Show the tracks** draws each point on the frame shown, with a short trail of where it was and will be.
- Pick what the point is (**Left foot**, **Right foot**, **Left hand**, **Right hand**, **Head**,
  **Other**), **Add point**, and click it on the frame. **Suggest** offers the subject's furthest points on
  the frame (head, hands, feet, a tail: the ends of its silhouette, for animals too); click one to track it.
- **Track** follows every point through the whole clip. When a point slips, step to a frame where it is
  wrong and drag it into place: that frame becomes a seed, and the stretches either side are tracked again
  from it and blended. Change a track's role in the list; **Remove** deletes it.
- A foot track's **contacts** are where it stays still: planted. A hand's or the head's turns are where it
  reverses: extremes worth a key.
- **Plant feet** sets the foot's IK goal in every key inside one of its contacts: over the point where the
  tracked foot meets the floor through the reference [camera](#camera), at the foot's standing height. A pose
  another key shares is copied for the key first. It needs the camera set up, and works best tracking a
  textured point on the shoe near the sole: a point on the outline's edge can slide onto the floor behind.

The tracks belong to the clip and are kept with it, whichever motion uses it.

### Camera

The camera the video was filmed with, as the stage's camera.

- **Look through** frames the viewport as the video: the reference camera's place, roll and lens, with the
  video's frame filling the film gate. Orbiting still works and moves the view, not the camera.
- **Set from view** makes the view as it is now the reference camera: orbit until the grid lies on the filmed
  floor and the character stands where the subject does, then set it. Without a camera yet, Look through
  starts from the view.
- **Lens** — the focal length, on the chosen **sensor** (a phone's is usually quoted as a 35 mm equivalent:
  use Full frame). A frame filmed upright takes the sensor's long side.
- **Turn** turns the camera about the subject, so it faces another way in the shot.

The line under the lens reads the camera back: its field of view, tilt, roll and height over the ground.

### Calibrate

Solves the camera from lines drawn on the frame, with no guessing by eye. **Show the lines** draws them over
the video:
- the **red** lines go along one direction of the filmed floor (tile edges, a road, the foot of a wall), the
  **blue** along the direction square to it. Each pair is dashed on to where it meets: its vanishing point.
  The yellow dashed line is the horizon they give.
- the **white cross** goes under the subject's feet: the world's origin, where the character stands.
- the **green mark** goes on top of the subject's head, straight above the cross: with its **Height** it sets
  how far away the camera is. **Ruler** instead takes two points on the floor a known **Length** apart.

**Two axes** solves the lens too, from where the two pairs meet. When one direction of the floor runs
straight across the frame (a shot square to a wall), its lines never meet: use **One axis + lens**, give the
lens, and draw the blue lines along the floor going away and one red line across it (for the roll).

The camera follows every drag, and is set when the drag ends. The line under the switches says what was
solved, or what is wrong (lines that never meet, a cross above the horizon).

### Match pose

Solves the camera from the character itself. Pose the character as the subject is in the frame, pick a
joint, **Pin**, and click where that joint is in the video; do the same for four joints or more, spread over
the body. **Match the camera** finds the camera that puts each joint on its pin. **Solve the lens too**
frees the lens as well (five pins or more). **Show the pins** draws them, each with a line to where the
camera puts its joint; the error in pixels follows the button.

### Keys

**Key from frame** makes a key at the playhead with a new pose, named after the video's frame: the motion as
it is at that moment, ready to be posed against the frame. While a key is selected the viewport holds its
pose over its frame, and the transport's frame steps still move the video, to compare the frames around it.

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

**File ▸ Save as Asset…** keeps the motion in the shared library. Every change then reaches each project's
`/Creator/Motion` folder as an animation asset on the mannequin's rig. The rig is reused when the project
already has it, and added when it does not. The clip is linked to the rig, so every model on that rig, or
retargeted from it, lists the clip. Use it from an animator state, an action slot or a blend space like any
other. Its events are set there, in the clip player, and kept when the motion changes.

Library poses reach every project's `/Creator/Poses` folder as Pose assets on their subject's rig, the IK
goals solved into the bones' rotations. Editing one here re-bakes every motion on this character that uses
it, and both reach the Editor.

### Additive clips

A clip played on an animator's **additive** layer (a recoil, a hit flinch, a breath) adds what it does relative to
its own **first frame**. Make the first key the neutral pose (no bone turned), shape the motion in the keys after
it, and end on the neutral pose again, so the layer adds nothing at either end. Keep **Variation** at `0`: a drift
would be added too. A hit flinch from the front: neutral at `0`, the chest thrown back and the head lagging at
`0.08` s eased out, a small overshoot forward at `0.25` s, neutral again with a spring by `0.6` s; its left and
right versions are one **Mirror** apart. The Sandbox's hit reactions are made this way (see
[Sandbox: hit reactions](../editor/sandbox-example.md#hit-reactions)).

A character reaches every project's `/Creator/Characters/<name>` folder by itself, with no save step. Its
visible clips become one animation asset each, on the rig of its skeleton. Hiding or deleting a clip
removes its asset, unless something in the project uses it. The model itself is not imported: add it to a
project with the Editor's **+ Add**, and it plays the clips.
