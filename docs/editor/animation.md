# Animation

Everything about how a character moves lives in one place: its **Character Animation workspace**,
one tab per skeleton. It has four parts, switched from the bar under the tab strip:

| Part | For |
|---|---|
| **Skeleton** | The bones: humanoid mapping, [sockets](#sockets), [bone masks](#bone-masks), [poses](#poses), [foot placement](#foot-placement), ragdoll and retargeting ([the bone mapper](models-and-materials.md#the-bone-mapper)). |
| **Clips** | The [clip player](#the-clip-player): one `.anim`'s clips played on a character, with their [events](#events-on-the-clip) and root motion. |
| **Animator** | The graph that decides which clip plays: states, transitions, parameters, layers and action slots. |
| **Blend Spaces** | Clips mixed by speed, direction or any other parameter — see [Blend spaces](#blend-spaces). |

Opening any of these — double-clicking a `.rig`, `.anim`, `.animator` or `.blendspace`, or the ✎ on a
character's **Animator** row (its inspector's Skeleton section) — opens that skeleton's workspace on the right
part. The workspace is **one document**: its tab shows ● while anything in it is unsaved, and
**Save** (the button on the bar, or Ctrl+S) saves every unsaved part at once. Closing the tab closes
every part, with one prompt.

One idea holds it together: **a character has a skeleton, the skeleton owns the clips, and an
animator drives them.** Clips are linked to the *skeleton*, never to a single model, so every
character built on it plays them.

Motion itself — keys, poses, blending, retiming — is authored in [Cleo Creator ▸
Motion](../creator/motion.md), and reaches every project's `/Creator` folder by itself. The editor
wires clips to characters and plays them: animators, blend spaces, foot placement, sockets, and the
[events](#events-on-the-clip) that tie a moment of a clip to a script.

The runtime API is in [Animation (scripting)](../scripting/animation.md).

## The Skeleton part

The workspace's **Skeleton** part edits what every character built on the skeleton shares. Pick a
bone in the **Skeleton** panel's bone tree or in the viewport; [foot placement](#foot-placement) is set
up in the **Foot Placement** tab beside Properties, with the tree still up. Properties holds, from the top:

- **Preview character** — which character built on the skeleton the preview shows. Every one of them
  plays the skeleton's clips, so the choice only changes what you look at. With no character on the
  skeleton yet, only its bones are drawn; link one from a model's Rig slot.
- **Clips** — the animations linked to the skeleton, so every character on it plays them.
  **+ Link Animation…** picks one from the library; dragging one in from Assets does the same.
- **Blend Spaces** — the [blend spaces](#blend-spaces) authored on the skeleton; click one to open it.
  **+ New Blend Space** needs a character on the skeleton to author it against.
- Its [sockets](#on-the-skeleton) and its [poses](#poses).

Its ragdoll and its bone masks each have a tab of their own beside Properties: **Ragdoll** (see
[Physics](physics.md#the-ragdoll-panel-rig-editor)) and **Bone Masks** (see [Bone masks](#bone-masks)).
Double-clicking a `.mask` in Assets opens the skeleton on its Bone Masks tab, with that mask expanded.
- **Retargeting** — corrections for clips authored on another skeleton. Pick the source under *Clips
  from…*, then **Map bones…** opens the [bone mapper](models-and-materials.md#the-bone-mapper). Fix a
  bone once and every clip from that skeleton retargets onto this one the same way, permanently.
  Corrections are kept per source skeleton; **Reset** discards that source's.

## The clip player

The workspace's **Clips** part plays one `.anim` at a time — pick it from **Clips ▾** on the
workspace bar, or double-click it in Assets. Clips are not edited here: they are authored in [Cleo
Creator ▸ Motion](../creator/motion.md). Here a clip is played on a character, given its
[events](#events-on-the-clip) and its [root motion](#root-motion). Each change is written to the
`.anim` as it is made — there is nothing to save — and **Ctrl+Z** undoes it.

The **Clip** panel holds:

- **Clips** — the clips in this `.anim`; pick one to play it. A clip made with an older version of the
  editor may still carry an edit stack (mirror, trim, pose offset, in place, retime). It keeps playing
  exactly as before, the panel says how many edits are applied, and **Remove** plays the clip as it was
  imported.
- **Preview character** — with more than one character on the skeleton, which one plays the clip.
- **Root motion** — below.

**Timeline**, in the bottom strip, plays and scrubs the clip on the preview character. Under the scrubber are the
clip's **Events** track and its [foot-lock rows](#foot-lock-windows).

A clip synced from Cleo Creator (in `/Creator`) belongs to the Creator, which re-makes it on every sync:
only its events and foot-lock windows can be changed here, and those survive the next sync.

### Root motion

Root motion lets the *animation* physically move the character — the body if it has one, otherwise
the model node — instead of returning it to where it started. Each clip makes one of two choices:

- **Leave in the clip** — the mesh travels and the character node stays put: the raw import.
- **Drive the character** — the root's motion is extracted at runtime and moves the character.

Drive the character for turn-in-place and other clips whose animation is authoritative. Locomotion
that physics velocity already moves must not drive the character as well, or it double-moves; author it
in place instead, in the Creator. A blend-space state ignores root motion entirely, and only the base
layer applies it — never a layer or an action. A clip whose older edit stack includes **In place** has
its travel removed already, so the choice stays locked until those edits are removed.

## The Clips panel

The Animator part's **Clips** panel lists the clips its machine can name — the clips the character's
skeleton owns.

- **Import Animation…** — glTF, GLB or FBX, through the retargeting flow described in
  [Models and materials](models-and-materials.md#animation-import-and-retargeting).
- **+ Link Animation…** — plays the clips of a `.anim` already in the library; dragging one in from
  Assets does the same.
- **From linked animations** — clips from a linked `.anim`. Renaming one renames it in that asset,
  and every model using it follows. To remove one, unlink its animation.
- **This model’s own clips** — clips stored on the character itself rather than in a linked asset.
  Rename them here, or delete one with ✕.

Clips belong to the model's **rig**, so every character built on that skeleton inherits them.

## The Parameters panel

The Animator part's **Parameters** panel holds two lists: the machine's parameters and its action
slots. Events are not the animator's — they belong [on the clip](#events-on-the-clip).

**Parameters** — **Number**, **Toggle**, **Trigger** or **Linked**. The first three are set from a
script; a **Linked** parameter follows a value by itself:

| Binding | Reads |
|---|---|
| **Built-in** → Self / Parent / Scene | An engine-measured value: `planarSpeed`, `isGrounded`, `turnRate`, … |
| **Variable** → Self / Parent / Scene | A node variable. |

A bound parameter needs no script at all — the machine reads it every frame. The full built-in list
is in [Animation built-ins](../reference/animation-builtins.md). Under **Built-in · Reactions** are the
character's [reaction values](#reaction-parameters): whether its body is down, whether it can get up, where the
last hit came from.

A **Trigger** fires when a script calls `setTrigger` — or, set to **Each hit** beside it, every time the
character takes a hit (its reactions' hit count rises). A hit nothing takes that frame is dropped, so a flinch
never plays a second late.

> **Bind Speed to the built-in `planarSpeed`**, not to a script's intended speed. It is *measured*,
> so a character jammed against a wall reads 0 and drops to idle instead of running on the spot; it
> ignores falling, so a jump never reads as a sprint; and it lets a blend-space axis be in real
> world units.

**Action slots** — named places a script plays one-shots into, without wiring them into the graph.
See [Action slots](#action-slots).

## The Animator

Two views, switched with the **Animations | Graph** control:

- **Animations** — the character in the viewport, with a transport to play and scrub a clip, and the
  clip's [Events](#events-on-the-clip) track under it.
- **Graph** — the state graph, below.

### The graph

A node canvas. Drag states around, drag handle to handle to make a transition, right-click for a
menu, Delete to remove. Edges are labelled with a summary of their conditions. One state is the
**entry** — select a state and press **▶ Make this the entry state**, or use the right-click menu.

**A state entered by a trigger** shows it as a tag with a lightning bolt under its name: when a script fires that
trigger by name — `setTrigger('Roll')` — the layer goes to the state from whatever it is doing, with
no transition drawn. Set it with the state's **Enter on trigger**.

**Any State** sits left of the states. A transition dragged out of it can fire whichever state the
layer is in, the moment its conditions hold. Nothing transitions into it, and it cannot be deleted.

Each frame the first of these that holds wins: an Any State transition, then a state's own trigger
(states higher in the list first), then a transition out of the current state, then one out of its
[group](#state-groups). A transition into a [fork](#forks) counts only when it can go on through one of the
fork's ways out.

The toolbar carries a layer dropdown — **Base**, or one of the machine's layers — that picks which
[layer](#layers-and-bone-masks) the canvas shows, with **+ Layer** beside it. The highlighted state is that
layer's current one.

### Undo

**Ctrl+Z** undoes an edit to the animator and **Ctrl+Shift+Z** (or Ctrl+Y) redoes it, on the animator tab's own
history. That covers the graph and the panels beside it: a state, transition, condition, group, fork, parameter,
layer or slot added, changed or removed, a node moved, a reroute point added, dragged, turned or deleted, and
**Tidy**. **Edit ▸ Undo** names the step ("Undo Rename group").

- **One step per action.** A drag of several selected nodes, a group ungrouped, or Tidy (Any State included) undoes
  whole. A name typed letter by letter, or a number scrubbed, is one step while you keep at it.
- **Undo shows where the step was made.** It switches to that layer and opens that group, and keeps the selection
  while what it names is still there.
- **Text fields keep their own undo.** Ctrl+Z while typing in a field undoes the typing, not the graph.
- **A clip renamed or deleted from the Clips panel clears the animator's history.** That change is written to the
  model, or the clip's `.anim`, at once, and the steps before it would put back states naming the old clip.

Undo changes the working copy, not the saved animator: an undone edit still needs **Save** (Ctrl+S).

### Reroute points

A busy graph's lines cross its nodes and each other. A **reroute point** routes a line, as a reroute node does in a
Blueprint: **double-click a line** to put one where you clicked, then drag it. The line runs through each of its
points in turn, and passes through a point either **left to right** (-o-) or **top to bottom** (| o |), whichever
way it is heading there. Hover a point for its two buttons: the first turns it from one to the other, the second
deletes it (so does Delete with it selected). Double-clicking a line never adds a state.

The points are layout, like a state's position: saved with the animator, by layer, and ignored by the game. A line
drawn at the top and the same pair's line inside an opened [group](#state-groups) keep their own. A line that goes
away (its transitions removed, a state deleted or moved into a group) takes its points with it; a rename keeps them.

### Tidy

**Tidy** (the columns button in the graph toolbar's icon group) lays the view out for you: the whole layer, or the
group that is open. Each node takes the column of the fewest lines from the entry to it (the entry, and Any State,
in the first), each column ordered to keep the lines between neighbouring columns short, the columns spaced by
their widest node. It clears the view's reroute points, which were placed for where its nodes were. Then route the
lines that still cross a node.

### State groups

A graph with every turn, stop and landing drawn out is a tangle: each of them has its own way into the air
and its own way back into the run. A **group** puts several states under one name and draws them as one
node.

- **Out of a group.** A transition from a group fires from any of its states. A state's own
  transitions are tried first; the group's come after them.
- **Into a group.** A transition into a group enters its **entry** state (its first state, unless you
  pick one).

So the four turns in place share one way into a jump, one into a fall and one into the run. Each turn
keeps its own way back to Idle when it ends.

**Drawn as one node.** The group shows its name and how many states it holds, then a row of **ports**:

- on its left, one per outside state its transitions come from;
- on its right, one per place they go.

A line from a port stands for every transition between those two ends. Select it and the inspector
lists them, each one click from its own settings. A **dashed** line is the group's own transition, from
or to the group itself.

**Opening a group.** Double-click a group, or use the open button, to see inside it:

- its states;
- a stand-in for each outside end (double-click one to go to it);
- **Any state in *group***, where the group's own transitions start.

The breadcrumb in the toolbar goes back to the whole layer. A state added while a group is open is one of
its states.

**Making and changing groups:**

- **Group.** Select states (Ctrl+click, or Shift+drag a box), then use the group button on the toolbar
  or **Group** on a state's right-click menu.
- **Move to *group*** and **Take out of group** are on the right-click menu too. So is the state's
  **Group** field in the inspector.
- **New transitions.** Drag from a group's top-right handle to add a transition out of it, or onto its
  top-left one to add one into it.
- **Ungroup** puts the states back on the graph and keeps what the group did. Each state gets the
  group's ways out as its own (after the ones it had), and a transition into the group goes to its entry
  state.
- **Delete.** Delete on a group removes it with its states.

Groups are per layer. Names are unique across states, groups and [forks](#forks): a transition that names one
means only that.

### Forks

A fork is a junction in the graph that transitions go through: one way in for each state, and one set of ways out
they all share. The machine never stays in a fork. A transition into one goes straight on, in the same frame, to the
first of its ways out that holds.

Without forks, a choice several states make the same way is drawn once per state. With eight grounded states and
three ways into the air (a running jump, a standing jump, a fall), that is 24 lines. With a fork, it is one line from
each state into the fork and three out of it.

It is drawn as a small pill with a diamond, its ways in and out under its name. Each way out's line starts with its
**rank**, the order its ways out are tried in.

- **A way in fires only on through a way out.** If none of the fork's ways out holds, the way in waits, and the state
  it leaves tries its next transition. So a way in usually has no conditions of its own: the fork decides.
- **First that holds.** The ways out are tried in their order, 1 first. Change the order in the inspector.
- **Gates are the state being left's.** Every exit time, **stay at least** and condition, on the way in or a way out,
  is tested against the state the machine is leaving. That is what lets a way out wait for a run's phase.
- **Blend.** The cross-fade is the way out's when it sets one, else the way in's. Set it where it belongs: on a way
  out when it goes with where the line leads (a fall blends in slower than a jump), on a way in when it goes with where
  it leaves.
- **Triggers.** The triggers on the path taken are used up; a way out that was only tried leaves its trigger raised.
  Put a trigger on a way out, not on a way in: a way in that waits on its ways out keeps its trigger raised, and it
  fires later.
- **Into the state already playing.** A way out back into it is passed over, and the next is tried (from Any State,
  **can restart itself** on a leg restarts the state instead).
- **Chains.** A way out may lead into another fork. If that fork has no way out that holds, the first fork tries its
  next one.

**A fork in a group.** Make a fork a group's entry, and a transition into the group goes on through the fork. The
group is then entered by one line from each place, and the fork inside picks the state. A group's own ways out
never apply to its forks: the machine is never in one.

**Making and changing forks:**

- **Fork**, the first button of the group strip on the toolbar, adds one. Added while a group is open, it is one of
  that group's.
- **New transitions.** Drag onto a fork for a way in, and out of it for a way out.
- **Dissolve** takes a fork away and keeps what it did. Each way in becomes one transition to each way out, in the
  fork's order and where the way in was. Their gates are joined, the later exit time and the longer stay are kept, and
  so is the way out's blend. A pair of states that already has a transition keeps that one.
- **Delete** on a fork removes it with every transition into and out of it.

### Sync groups

A cross-fade between two looping cycles, a walk and a stair climb say, normally starts the new one at its first frame
wherever the old one was in its stride. Halfway through a step, the blend then mixes one cycle's planted left foot with
the other's swinging one, and the legs drag across each other.

States in one **sync group** (the **Sync** field) hand over in step instead:

- the state entered starts where the one it leaves was in its cycle, by share of the cycle (a blend space's phase, or
  a looping clip's time over its length);
- through the cross-fade the two blend spaces move as one, at the pace of their mixed cycle;
- a transition into a state outside the group, or into the same state again, starts it at its beginning as before.

For this to line the feet up, phase 0 must be the same foot's plant in every state of the group: shift each blend
space sample with its **phase offset** until it is. An exit time on a synced state counts from the phase it was
entered at, and so does its play count.

A sync group is not a [state group](#state-groups). State groups share transitions; sync groups share a stride.

### The inspector

The Animator part's **Animator** panel edits what the graph has selected. With a layer picked it starts
with that [layer's settings](#layers-and-bone-masks).

**Save** commits the animator: onto the character it was opened from, or — when it is a
[shared animator](#shared-animators) — into the `.animator` asset.

#### Selected

Whatever is selected in the graph: a state — what it plays, and how — or a transition, one each way
between two states, with its conditions.

**A selected state:**

| Field | Meaning |
|---|---|
| **Name** | |
| **Enter on trigger** | Triggers that start this state directly, by name, from whatever state its layer is in — a script's `setTrigger('Roll')` plays the state listing Roll. Each with its own **blend** in, and **restart**: on, firing it while the state plays starts it over (a second hit replays the flinch); off, the trigger waits. A name that is not a parameter yet becomes a trigger. |
| **Plays** | **Clip**; **Blend Space** — a [blend space](#blend-spaces) with per-axis parameter bindings; or **Pose** — a static pose from a [pose asset](#poses). On the base layer also **Ragdoll** (the falling-figure icon) and **Get up** (the rising figure): the body's own states, see [Ragdoll and Get Up states](#ragdoll-and-get-up-states). |
| **Starts** | A Ragdoll state: what entering it does to a character on its feet — **Fall** (it falls the way it was moving), **Trip** (its feet are taken from under it) or **Limp** (it drops out cold). Entered when a hit has already knocked it down, it adds nothing. |
| **Without a body** | A Ragdoll state: the clip under the body, and what shows where no body can be made. None holds the pose it was entered with. |
| **On back**, **On front** | A Get Up state: the clip it rises on lying on its back, and on its front. Empty uses the rig's own get-up clips (its [Reactions tab](reactions.md#get-up)). |
| **React** | [Reaction effects](#reaction-effects): how the body takes hits while this state plays — **Full**, **Flinch** or **None**. |
| **Hands** | Reaction effects: hands that stay on what they hold rather than reach for a wound. **Auto** is both while a support-hand IK holds a weapon. |
| **Force ×**, **Shove ×** | Reaction effects: hits land, and shoves carry it, this many times as hard. |
| **Loop** | |
| **Play count** | |
| **Speed** or **speed parameter** | Playback rate. |
| **× param** | A parameter the rate is multiplied by, live — one number speeds up every state that names it (a boss's second phase). A missing parameter multiplies by 1. |
| **Start at** | Clip seconds to start from: one segment of a longer clip. A transition that waits for the clip end at that segment's end hands over to the next. |
| **Frames** | Stop motion: the state's clip shows this many held poses a second (`fps`); empty plays smooth. The beat is in game time, whatever the state's speed — a faster run takes bigger steps between poses, not more of them — and it carries on from state to state, so a character keeps one rhythm. A blend space holds all its clips on the same frame. Only the poses step: the clip's events, exit time and [root motion](#root-motion), cross-fades, blend weights, layers and foot placement stay smooth, so the character still travels smoothly. Not on a pose state. |
| **Extract root travel** | On a layer: the clip's ground travel is collected for a script's `consumeRootMotion()` instead of moving anything, and the root is held over the start spot. A roll that covers exactly the ground the dive does. |
| **Foot-placement weight**, optionally from a parameter | How strongly foot placement applies in this state. On a layer it applies as far as the layer shows: a roll at 0 eases foot placement out and back in with the layer. |
| **lock** | Foot locking in this state, when the skeleton has it on (default on). Off, the state plants no foot, and a foot locked when it was entered fades back to the animation: a standing Idle whose small weight shifts should not be pinned. |
| **windows** | Plant the feet by the clips' [foot-lock windows](#foot-lock-windows), at any height: a foot inside one keeps its ground correction however far above the other foot the clip holds it. Off by default, when foot placement reads a raised foot as swinging and lets it go. For a stair climb, whose upper foot stands a riser above the lower one: released, it floats over its tread. |
| **Hold** (the planted-feet icon beside **lock**) | Base layer only. While this state plays, the Character it animates stops steering: no speed, no turning; gravity is kept. Only the clip's [root motion](#root-motion) moves it. For a clip that must not travel with the speed it came in with or with the stick, a hard landing say. Its way out should wait on the input (**MoveInput**), not on speed, which is 0 meanwhile. |
| **Group** | The [group](#state-groups) it is in, when the layer has any. The group's own transitions leave from this state too, after its own. |
| **Sync** | Its [sync group](#sync-groups): a name it shares with the states it should hand over to in step. Pick one the animator already has, or type a new one. Not the same as **Group**. |
| **Steady** | On an override layer: how much the state's pose keeps its own turn in model space at the top of the layer's mask (the spine of an upper-body mask), whatever the hips beneath it do. `0` (the default) rides the hips and sways with the walk; `1` holds still. See [Steady holds](#steady-holds). |
| **Links** | The states this one connects to, and which way (→ out, ← in, ⇄ both). Drag from the state's right handle in the graph to add one. |

**A selected group:**

| Field | Meaning |
|---|---|
| **Name** | No state or other group may have it. A rename follows into every transition from or to the group. |
| Open, Ungroup, Delete | Open it in the graph; ungroup it (its states keep its transitions); delete it with its states (asks first). |
| **Entry** | The state a transition into the group enters. |
| **States** | Its states, each a click from its own settings. Each row has buttons to make that state the entry or take it out of the group. **+ state** adds one. |
| **Its own transitions** | The transitions from and to the group itself, each a click from its settings. |

**A selected fork:**

| Field | Meaning |
|---|---|
| **Name** | No state, group or other fork may have it. A rename follows into every transition from or to the fork, and into its group. |
| **Dissolve** | Take the fork away and keep what it did: each way in joined to each way out (see [forks](#forks)). Delete removes it with its transitions. |
| **Group** | The [group](#state-groups) it is in. The entry button beside it makes it the group's entry, so a transition into the group goes on through it. |
| **Ways in** | The transitions into the fork, each a click from its settings. A transition into a group whose entry is the fork is one too. |
| **Ways out** | Its ways out, in the order they are tried: the first that holds is taken. The arrows move one earlier or later. **+ way out** adds one, tried after the rest. |

**A selected line that stands for several transitions** (a group's ports) lists them; pick one to edit it.

**A selected transition:**

| Field | Meaning |
|---|---|
| **Wait for clip end** | Wait until the source clip reaches a point (1 = its end). |
| **Blend** | Cross-fade seconds, per transition. Not used into a Get Up state: the skin blends from the body. |
| **Stay at least** | Least time in the source state before this may fire. |
| **Can restart itself** | From Any State only: fire even while already in the target state, restarting it — a second hit replays the flinch. |
| **Conditions** | A tree of AND/OR groups over parameters. |

#### Preview

It simulates the machine *as you are editing it* — no save needed — and lets you drive parameters by
hand, which is far quicker than pressing Play to find out whether a transition can fire.

### The tolerance is not optional

Every `>` / `<` condition can carry a **tolerance** (`tol ±`), and on anything measured you need it.

`Speed > 0.1` leaving Idle and `Speed < 0.1` leaving Locomotion are each obviously correct on their
own, and together they are the most common way to make a character vibrate: a speed hovering at
`0.1` satisfies both on alternating frames, so the machine flips state every frame and re-arms a
cross-fade from a pose that has barely moved. **It looks like a blend problem, and it is not.**

With `± 0.1`, `> 0.1` does not engage until `0.15` and `< 0.1` not until `0.05`. The editor flags a
`>` / `<` pair whose engage points do not separate, and the runtime logs
`Animation state machine is ping-ponging: …` naming the two states if one slips through.

Root motion sharpens this: a turn clip's root motion physically moves the character, which feeds
Speed, which is what the turn's exit reads. Without the band, an idle turn can trip its own exit.

## Shared animators

A **shared animator** (`.animator`) is an animator as a library asset — parameters, states,
transitions, layers and action slots — the way Unity's Animator Controller or Unreal's Animation
Blueprint is. One zombie animator can drive every zombie.

Make one:

- **Animator ▾ → + New Animator** on the workspace bar, for that skeleton.
- **Assets → + Add → Animator** creates an empty one.
- **Share…**, at the top of the Animator's panels, turns the one you are editing into a shared one.

Double-click it to open it in its skeleton's workspace. It is previewed on a character built on that
skeleton.

### Using one on a character

A character runs either **its own animator** or a **shared** one, picked on the **Animator** row of its
inspector's Skeleton section (under **This character**).

| Control | Does |
|---|---|
| **Its own** / **Shared: *name*** | Which animator the character runs. Shared animators on the character's skeleton are offered, plus any with none. |
| ✎ | Opens the workspace on it. |
| **Clip overrides (this character only)** | Every clip the shared animator plays, each with an optional replacement: the row says how many are swapped, click it to list them. A crawler on the shared zombie animator can swap its Walk for a crawl. This is Unity's Override Controller. |

While editing a linked character, the bar above **Save** names the shared animator. Saving writes the
asset, and **every character using it updates**. **Detach** stops following it: the character keeps
a copy as its own.

> A character holds a resolved copy of its shared animator — that is what plays, and what ships in a
> template, a bundle or a published game. Deleting a shared animator therefore leaves every character
> running the machine it last copied; it just stops tracking the asset.

## Layers and bone masks

A machine can have **layers** above the base. Each layer runs its own states and transitions over
the **same parameters**, and is blended on top of everything beneath it — the legs keep walking on
the base while an upper-body layer aims, waves or holds a torch.

Add one with **+ Layer** on the graph toolbar; it is picked in the layer dropdown beside it, where you pick a
layer to edit its states.

**Layer** — the section at the top of the Animator panel while a layer is picked, titled with
the layer's name. It holds that layer's own settings:

| Field | Meaning |
|---|---|
| **Name** | What scripts address it by. ✕ deletes the layer and its states. |
| **Blend** | **Override** replaces the pose beneath, by weight × mask. **Additive** adds the clip's motion *relative to its own first frame* on top — breathing, recoil, a flinch. A pose adds what it changes from its base pose (a [variant](#variants)), or from rest. |
| **Weight** | `0`–`1` from the slider, or **param…** to read it from a parameter every frame. |
| **Mask** | A [bone mask](#bone-masks), or **Whole body**. |
| **Plays over Ragdoll and Get Up** (the falling-figure toggle) | Off (the default), the layer fades out while the base layer is in a [Ragdoll or Get Up state](#ragdoll-and-get-up-states), and back in after: an aim or a weapon pose must not pull at a body lying or getting up. On, it keeps playing. |
| **Hand IK** | **Left** or **Right**: after every layer, that hand reaches where this layer's own pose has it relative to the other hand, so a weapon held in the other hand keeps both hands on it whatever the layers above do to that hand (an aim, recoil). **Reach** is how firmly, `0`–`1` or from a parameter (`0` lets go: a sprint). **Socket**: reach a socket on the other hand instead. |

Three rules worth knowing:

- **An empty state adds nothing.** A state with no clip on a layer means "this layer is off": the
  layer fades out while it is there, and fades back in when it leaves. That is how an upper-body
  layer gets out of the way.
- **Only the base layer drives root motion.** Two layers both moving the character would double it.
  A layer state can still **extract** its clip's travel for a script to move the body by.
- **A deleted mask switches its layer off**, rather than letting it cover the whole body.
- **A trigger reaches every layer.** Triggers are lowered once the base and every layer have
  evaluated, so a `Died` that sends the base to Dead also takes a layer out of what it was playing.

### Steady holds

An upper-body layer that holds a pose rides the hips: as the walk sways and twists the pelvis, a held
rifle swings with it. **Steady** (a state's setting, on an override layer) keeps the top of the layer's
mask turned the way the pose itself has it in model space. At `1` the chest holds the pose's turn
whatever the legs do (walking, running, on a flight of stairs); at `0.5` it keeps half the hips' turn.
Everything further down the mask rides in local space, so both hands stay on what they hold, and layers
above (a lean) still tilt it. One held pose then replaces a per-gait upper-body clip. Steady eases over
the transition into the state, and does nothing on an additive layer or a whole-body one (it has no top).
The pose's own hips are what it measures by, so capture a hold with the hips as the character stands.

### One-shots as an Actions layer

Attacks, rolls, hit reactions and gestures can live in the graph instead of a script's
`playAction`: a full-body layer on top of every other, resting in an empty state, with one state per
one-shot, each entered by its own trigger (**Enter on trigger**) — the script fires it by name and
names nothing else. Each returns to the empty state when its clip ends (**wait for clip end**, with the
blend-out as **Blend**), so the layer fades out on its own. The clip, its speed, its start and its
blends are the graph's to tune; the script only says when.

- Leave each one-shot a little before its end — **wait for clip end** at `1 − blend × speed ÷ length` —
  and the blend-out finishes with the clip, as an action's does.
- A combo authored as one clip is a state per segment (**Start at**), each handing over to the next on
  its own trigger at the segment's end. Give a follow-on segment no **Enter on trigger** of its own, or
  its trigger would start it as soon as it is fired.
- Give the empty state the ways back from anywhere as its own triggers, and keep it first in the list
  so they win a frame where a one-shot fires too: a death, a trigger with a blend (standing up from a
  bonfire), and one with none, for a one-shot whose pose must not blend into what follows.

The Hollow Keep and Valley characters work this way; see [Scripting: Animation](../scripting/animation.md#one-shots-in-the-graph).

### Bone masks

A **bone mask** (`.mask`) says which bones a layer or an [action slot](#action-slots) may move, and
how strongly — an *Upper body* mask keeps the legs on locomotion. Masks are made and edited in the
workspace's **Skeleton** part, on its **Bone Masks** tab, against that skeleton:

- **+ New mask…** starts from a preset — **Upper body**, **Lower body**, **Left arm**, **Right arm**,
  **Head**, found by bone names — or **Empty**.
- Expand a mask to see the skeleton with a checkbox per bone. **Click** a bone to include its whole
  branch (tick the spine and the upper body follows); **Alt-click** to toggle that one bone alone.
- An included bone has a **weight**, `0`–`1`: how strongly it follows the layer.

Masks store bones by **name**, so a re-export cannot repoint them. An edit reaches every character
using the mask without saving the animator again.

## Poses

A **pose asset** (`.pose`) holds named static poses of one skeleton, each a set of per-bone changes
from rest — a hand grip, a weapon hold, an aim, an injured stance. It is Unreal's Pose Asset.

**Using.** A state holds a pose: set **Plays** to **Pose** and pick it. On a masked layer, that is a
hand closing around a weapon while the rest of the body keeps moving. A [blend space](#blend-spaces)
sample can hold a pose too.

### Editing a pose

Poses are edited on the character, in the **Poses** section of the Skeleton part (the pose by itself)
and of the Animator part (with the character's layers on):

1. Press the pencil on a pose to edit it.
2. Click a joint on the character, and turn it: with the rotate gizmo, or the **X Y Z** numbers
   (degrees off rest, or off the base for a variant, in the parent bone's frame). **Reset** puts the
   bone back.
3. Every animator and blend space holding the pose follows at once. Each gizmo drag and each number
   is one undo step.

In the Animator part, **Show: Layered** keeps the character's machine running with every layer while
you edit (turn on **Preview › simulate**): a weapon hold edited under its aim, its Steady and its hand
IK, as the game shows it. **Pose alone** pins the pose by itself, as the Skeleton part always does.
For a pose a blend space holds, the crosshair beside it puts the blend space's probe on that sample.

**New pose** captures the character as it stands now (every bone off its rest) into the skeleton's own
pose asset. ✕ deletes a pose; its variants then hold what they change from rest.

### Variants

A **variant** of a pose stores only what it changes from it: **Add variant** (the branch icon) makes
one, listed under its base. Editing the base moves every variant with it; editing a variant changes only
that one. On an **additive** layer a variant adds what it changes from its base, so a blend space of an
aim pose's variants is an aim offset: edit the aim pose, and every direction follows; edit one direction,
and only it changes. **Make independent** (the broken link) turns a variant into a pose of its own, as it
looks now.

**Poses from Cleo Creator.** Poses made in [Cleo Creator ▸ Motion](../creator/motion.md#poses) reach
every project's `/Creator/Poses` folder as pose assets on their skeleton's rig, following every change
made there. They are read-only in the editor (the next sync would undo an edit): show one with its icon,
and a variant of one goes into the skeleton's own pose asset. States refer to a pose by id, so a rename
breaks nothing.

> Older projects stored poses on the rig itself. Those keep working, and the Poses section offers
> **Move into a pose asset**, which keeps every pose id so no clip referencing one breaks.

## Ragdoll and Get Up states

A character with [reactions](reactions.md) (on the Jolt backend) can have its body's own states in the graph, so
a fall, a knockout or a get-up is wired like any other state, with no script. They live on the base layer.

- **A Ragdoll state** — **Plays ▸ Ragdoll**. While the graph is in it the body is the physics'. Entered on its
  feet, the character falls as its **Starts** says; entered after a hit has already knocked it down, it only holds
  the body. Either way **the body never gets up by itself while the graph is there**: the graph decides when.
- **A Get Up state** — **Plays ▸ Get up**. The body rises on its clip, **On back** or **On front** as it lies,
  lined up with where it lies and blended from it. The transition's own blend, root motion and foot placement do
  not apply, and the character is held still. Entered before the body lies still, it waits on its first frame.
- While the graph is in either, the other layers fade out (unless one [plays over them](#layers-and-bone-masks)),
  and a way in from anywhere (Any State, **Enter on trigger**) to an ordinary state waits: a ragdoll is not pulled
  into a car. Its trigger is taken, so it does not fire later.

The usual wiring, which the graph toolbar's **Reaction presets ▸ Knock-down states** adds:

| From | To | When |
|---|---|---|
| Any State | Ragdoll | **Ragdolled** — the body has left its feet (a hit, a shove, a fall). Put it first. |
| Ragdoll | Get Up | **CanGetUp** — it lies still and alive, ready to rise. |
| Ragdoll | the entry | not **Ragdolled** — the body is up without rising (a respawn). |
| Get Up | the entry | **wait for clip end** at `0.95`. |

The graph can also start a fall by itself: a trigger into the Ragdoll state (the Sandbox's **Trip** key) knocks a
character on its feet down as **Starts** says. Leave the Ragdoll state for anything but a Get Up state and the
reactions get the body up themselves, on the rig's own clips. A script's `reactions.getUp()` while the graph holds
the body makes **CanGetUp** true. With no reactions (another backend) a Ragdoll state plays its clip or holds its
pose, and a Get Up state plays as an ordinary clip.

### Reaction effects

Every state, on any layer, has **Reactions** rows: how the character's body takes hits, shoves and impacts while
the state plays.

| Row | Meaning |
|---|---|
| **React** | **Full** (default): as its reaction set says. **Flinch**: flinches only, never staggered or knocked down. **None**: the body does not react — the hit still counts (its `reaction:Hit` event, the hit parameters). |
| **Hands** | **Auto** (default): both busy while a support-hand IK holds a weapon. **Both busy**, **Right busy**, **Left busy**, **Both free**: a busy hand stays on what it holds rather than reach for a wound. |
| **Force ×** | Hits land this many times as hard: a braced crouch `0.6`. |
| **Shove ×** | Shoves carry it this many times as far. |

The base layer's state and every layer's are merged: the strictest **React** and every busy hand of a state shown
at least half, the forces multiplied by how much of each state shows. A state with effects has a burst mark on its
node. A script's own `reactions.busyHands` wins over **Hands**.

### Hit reactions on a layer

**Reaction presets ▸ Hit reaction layer** adds an additive layer that flinches on every hit: an empty **Off**
state and a **Hit** state entered on the **Hit** trigger (set to fire on **Each hit**), playing a blend space over
**HitAngle** (where the hit came from) and **HitHeight** (how high it landed), back to Off near its end — the shape
of a recoil layer. Its weight is **HasControl**, so it rests while the body is down. Make the blend space's angle
axis wrap, from `−180` to `180`: `0` is a hit from the front, `+90` from the character's left, `−90` its right,
`±180` behind. A clip on an additive layer adds what it does relative to its first frame, so start each flinch on a
neutral pose — [Cleo Creator's Motion tool](../creator/motion.md#additive-clips) makes them so. Entered again by a
second hit, a one-shot blend space starts over.

### Reaction parameters

The **Built-in · Reactions** values, read from the character's reactions whatever node the parameter names:

| Name | Type | Meaning |
|---|---|---|
| `ragdolled` | boolean | The body is the physics': falling, tumbling, lying, dead. False once a get-up starts. |
| `canGetUp` | boolean | Lying still and alive, ready to rise (the rig's Get up delay), or asked to by `reactions.getUp()`. |
| `faceUp` | boolean | Lying on its back. |
| `reacting` | boolean | Any reaction has the body. |
| `hasControl` | boolean | On its feet, flinching or staggering. True where there are no reactions. |
| `staggering` | boolean | Shoved back on its feet. |
| `hitAngle` | number | Where the last hit came from against the facing, degrees, counter-clockwise like `planarAngle`. |
| `hitHeight` | number | Where up the body it landed, `0` the feet to `1` the top of the head, on the skeleton at rest. |
| `hitStrength` | number | How hard, `0`–`1` against the fall threshold. |
| `hitCount` | number | Hits taken so far: what a Trigger set to **Each hit** fires on. |

## Action slots

An **action** is a one-shot a script plays over whatever the machine is doing — an attack, a reload,
a wave — with no graph wiring at all. It fades in, plays, and fades out by itself; a second action in
the same slot cross-fades from the first. Unreal calls this a montage slot.

Slots are declared on the machine, in the Parameters panel's **Action slots** section, and a script
plays into one by name — `animator.playAction('Reload', { slot: 'UpperBody' })`:

| Field | Meaning |
|---|---|
| **Name** | What `playAction` asks for. |
| **Above** | Which layer the slot sits on top of — **Base** or any layer. |
| **Mask** | A bone mask, or **Whole body**. An `UpperBody` slot keeps the legs on locomotion. |
| **Blend** | Override or Additive, as for a layer. |

With **no** slots declared, an action plays full-body over everything. The script side is
[`animator.playAction`](../scripting/animation.md#actions).

## Events on the clip

An event marker belongs to the **clip**, and fires wherever that clip plays — a base state, a layer or
an action slot, in any animator — through `onAnimationEvent(name, clip)`. This is how a footstep, a hit
frame or a particle burst stays locked to the animation rather than to a timer.

Events are placed on the **Events** track, under the scrubber of the clip player's **Timeline** and of
the Animator and Skeleton transports:

- **+ Event** adds one at the playhead and asks for its name. A marker at time 0 fires when its clip starts.
- **Drag** a marker to move it, **click** it to rename, **right-click** it to delete.

Each change is written to the clip's `.anim` at once and can be undone. The Creator does not author
events, so a clip synced from Cleo Creator keeps the events placed here when it is re-synced. A clip
embedded in a model rather than kept in a `.anim` shows its events, read-only.

> Animators used to carry event markers of their own. Opening one in the workspace moves its markers
> onto the clips they name and says how many moved; save the animator to finish — until then a moved
> marker fires twice. A marker on a clip embedded in the model has no `.anim` to move to: it stays on
> the animator, still fires, and shows on the track as a hollow circle.

## Foot-lock windows

[Foot locking](#foot-placement) holds a planted foot on its spot while the body moves or turns over it. On its own
it decides by itself when a foot is planted. A clip can say instead, with **foot-lock windows**: per foot, the
spans of the clip in which that foot may lock. They are what to tune when feet stick to the floor too long, or let
go too early.

The Timeline shows one **Lock L** / **Lock R** row per foot, under the Events track:

- **Drag** on an empty part of a row to draw a span. Drag a span's **end** to move it, its **middle** to slide it.
  **Right-click** a span to remove it. A press without a drag scrubs, as on the Events track. Times snap to 1/60 s.
- **Detect** (the magnifier) sets the row from the clip itself: each span runs from the ball of the foot coming
  down until the heel has lifted 3 cm. The foot then follows the animation through the push-off instead of
  sticking until the toe leaves the ground.
- **Automatic** (the circular arrow) removes the row's spans. With none set, the animator decides by itself, as it
  always did. A row with every span removed is different: that foot never locks in this clip.

While a blend space plays, the samples that weigh most decide. While two states cross-fade, the two sides count by
the blend. Each change is written to the clip's `.anim` at once and can be undone. Windows are in the clip's time as
it plays, and they work on any character the clip is retargeted onto.

### Event actions

A marker says WHEN; the animator says WHAT. In the Parameters panel's **Event actions** section, add an
**Event**, pick its name from the markers the animator's clips carry (or type a new one), and give it
actions:

- **Play sound** — a sound node, found by name below the character and then below its parents. Shots
  overlap as the node's [Voices](audio.md#overlap) allow; turn **overlap** off to restart it instead.
- **Particles** — burst, start or stop a particle system node.
- **Flash light** — flash a light node you authored at intensity 0: a peak in lumens and the seconds it
  takes to fade.
- **Spawn** — instantiate a template at a node, turned like the node, like the camera or at fixed
  angles; **follow** keeps it on the node while it lives. A node inside a viewmodel is placed where it
  is *drawn*.

The animator runs them itself when the marker fires, so the effect stays in sync with the clip and
needs no script; `animator.fireEvent('name')` triggers the same bindings for something with no clip.
The bindings belong to the animator (and its shared controller), so a rifle and a pistol can bind the same
`shot` marker to different sounds. See [Event Actions](../scripting/animation.md#event-actions-effects-without-a-script).

## Blend spaces

A **blend space** (`.blendspace`) blends several clips by where a probe sits on a plot. Create one
from **Blend Spaces ▾ → + New Blend Space** on the workspace bar.

**Blend Space** (bottom) is the plot itself, with a draggable probe and a live preview. **Blend Space
Settings** (right) has three sections:

- **Field** — the blend space's name, **1D** or **2D**, and each axis's name and range. Switching to
  1D keeps the samples' Y positions, so switching back restores the layout.
- **Smoothing** — filtering for the measured parameters that drive the probe, which carry
  frame-to-frame noise into the pose unless it is filtered here. Per axis: **lag** (seconds for the
  probe to catch up with its parameter), **dead** (movement smaller than this is ignored outright) and
  **wrap** (the axis is a circle); plus **Weights**, how fast a clip fades in or out of the mix. It
  applies at runtime only: the preview always tracks the probe exactly, so placing samples stays
  direct.
- **Samples** — each sample's clip, coordinates, **rate** and **phase**, with its live weight at the
  probe. Double-click the plot to drop a clip; **+ Sample** adds one here. A sample can hold a **pose**
  instead (the list's **Poses**, variants under their base): a pose is held, with no rate or phase, and a
  clip in the same blend space alone sets its cycle. The same pose at many points is one pose (a carry
  held at every walking speed, a sprint pose at the sprint's). A blend space of a pose's
  [variants](#variants) on an additive layer is an aim offset that follows every edit to the pose.

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

> **Do not also set a playback speed on a blend-space state.** A blend space matches speed by
> *choosing clips*, not by playing one faster. Binding movement speed to both the axis and the
> state's rate multiplies it twice — the run plays 4× too fast and idle freezes. Switching a state to
> Blend Space clears the rate for you; just do not re-add one.

> **Idle does not belong in the blend space.** A single idle sample at the origin loses to the nearest
> walk clip at zero speed, because the plot blends by distance — the character drifts into a strafe
> while standing still. A separate Idle state sidesteps it.

> **If a diagonal looks like the legs are fighting**, the two clips start at different points in the
> gait. Set **phase** to `0.5` on one of them. If instead the pose *buzzes*, it is the probe, not the
> clips — open the Preview, turn on simulation, and read the spread column to see which value is
> moving.

Diagonals are synthesized: with only four cardinal clips, a probe at 45° reads as a blend of its two
neighbours. Real diagonal clips sharpen it but are not required.

A clip that is much shorter than the blend space's median foot-slides; the panel flags it and sets a
**rate scale** in one click.

## Foot placement

An analytic two-bone solver that plants feet on uneven ground.

Set it up in the Skeleton part's **Foot Placement** tab, beside Properties: select a joint — from the
bone tree on the left or by clicking it in the viewport — and assign it a role, **Thigh / Shin / Foot /
Toe**, per leg. There is a `⤓` name-matched auto-guess and a validation report.

It is stored on the **skeleton**, so every character built on it gets it. Per-state strength comes
from the state's foot-placement weight.

Each foot casts a ray from **Trace up** above the animated ankle to **Trace down** below it, and lands on
static and kinematic ground: never on a trigger, another character's capsule or a loose prop. **Trace
layers** are the [collision layers](physics.md#layers) it lands on, all of them by default. Leave out a
ramp laid over stairs for the character's capsule, and keep the steps' layer, which the capsule's
**Collides with** leaves out: the body glides up the ramp and the feet stand on the treads.

**Foot locking** (the **Foot locking** group under the tuning values) keeps a foot the animation has
planted where it is on the ground, and pointing the way it was, while the body moves or turns over it.
Without it a character that turns while it walks (following the camera, curving a run) carries its planted
feet round with it and looks as if it is on ice. **Lock** is the strength, 0 to 1 (0 is off).

- **Planting.** A foot plants when it is down (its ankle on the ground, its ball within **Plant height** of
  the lowest foot) and the clip holds it still: rising or sinking slower than **Plant speed**, and crossing the
  ground slower than that plus 1.5 times the body's own speed. A swing crosses the ground at about twice the
  body's speed.
- **Holding.** What is held is the ball of the foot, which stays down through heel-off. The foot also keeps its
  planted heading, up to 40 degrees off the animation's.
- **Letting go.** When the clip lifts it, or when the body has left it more than **Let go at** behind. A lock
  letting go never pulls the leg straighter than 97% of its length (or than the clip has it): it gives way
  instead, so a release still running as the leg swings does not drag it straight and snap the knee after it.
- **Catch below.** While the pose still blends in a clip with no foot-lock windows (setting off out of Idle, which
  slides the feet as it blends), a foot sliding over the ground faster than this is not caught: it plants once it
  has slowed. Blank or 0 catches any.

**Blending** (the group under Foot locking) is how a lock comes in and goes out, for every lock on the skeleton:

| Setting | Does |
|---|---|
| **In** | Seconds a planting foot takes to settle into its lock. It is held where it was as it planted, and the lock's weight rises over this time, so a foot that plants mid-slide slows to a stop instead of stopping dead. 0 locks it the frame it plants. |
| **Out** | Seconds a lifted foot takes to blend back to the animation. |
| **Curve** | The shape of both: **Linear**, or **Smooth**, which starts and ends gently so neither shows as a kink in the foot's path. |

A foot that plants again while it is still being let go keeps its spot and blends back in from where it is.

Locking follows foot placement: a state with no foot placement locks nothing, and a state's **lock** switch turns
it off there (Idle, typically).

## Sockets

A **socket** is a named attach point on a bone — where a sword, a torch or a hat is held. Sockets are
a property of the skeleton, so they live on the **skeleton**, and every character built on it gets the
same `RightHand`.

### On the skeleton

The Skeleton part's **Sockets** section:

- **+ Add socket on *bone*** adds one on the bone selected in the Skeleton panel, named after it.
- Expand a socket to change its **name**, its **bone**, and its offset from the bone: **Position**
  (metres), **Rotation** (degrees) and **Scale**. The viewport gizmo drags the same offset.
- **Preview model** shows a model on the socket in every part of the animation workspace —
  skeleton, clips, animator and blend spaces — so a sword can be checked against a swing. It is never placed in a scene.

A socket's scale ignores the **bone's** own scale. An FBX armature sits under a `0.01` scale, and a
socket that inherited it would shrink a held sword to a centimetre; the scale comes from the socket's
offset only.

Sockets are written into the skin of every model on the skeleton, so they travel with it into templates,
bundles and the published game. Renaming a socket detaches anything using the old name; deleting one
leaves its followers where they were.

### Attaching a node

Any node can follow a socket, from the **Socket** section of its inspector:

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
frame, and a camera following it sees it where the hand put it. The flip side is that a camera rig
(or a node under one) cannot itself be attached: the rig places it afterwards and wins. Attach the
rig's follow target instead.

## Debugging

- The **Animation blend** debug overlay shows the live blend read-out, and works during Play.
- The **Skeletons** overlay draws joints and bones.
- The Animator panel's **Preview** simulates without entering Play.
- Warnings flag oscillating transition pairs and unreachable ones.
- With a layer picked, the graph highlights that layer's current state.

## See also

[Animation (scripting)](../scripting/animation.md) · [Animation built-ins](../reference/animation-builtins.md) · [Third-person character](../scripting/third-person-character.md)
