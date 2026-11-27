# Reactions

How characters on a skeleton react with their whole body when they are shot, shoved, trip, drop off a
ledge, tumble down stairs or are thrown from a moving vehicle, and how they get up again. The body is a
**powered ragdoll**: physics moves it, but every joint has a muscle pulling it toward a pose, so it can
flinch, stagger, brace for the ground, cover its head, bend its knees to land, hold a wound and stand back
up. It is authored on the skeleton, in the **Reactions** tab beside its [Ragdoll](physics.md#the-ragdoll-panel-rig-editor)
tab, and tried on the tab's [test bench](#the-test-bench).

The model is the one behind NaturalMotion's Euphoria (used by Rockstar's games) and similar systems:
muscles per body region, reflexes called **behaviours** that run when their moment comes, and the
animation the character was playing as the pose the muscles reach for. The
[Reactive ragdolls reference](../reference/reactive-ragdolls.md) covers that background and its sources;
[Reactions (scripting)](../scripting/reactions.md) covers what a script can ask of a body.

## What you need

A skinned model with an animator, on a skeleton whose ragdoll is a **Rig profile** or the **Automatic
humanoid** (see [Ragdoll](physics.md#ragdoll)). A generic ragdoll has no body segments for muscles, so
models on it fall limp as before. Nothing else is required: every character on a suitable skeleton reacts
with the built-in **Default** set until the skeleton is given sets of its own.

To start:

1. Open the skeleton (its model's Skeleton section ▸ ✎ next to **Reactions**, or the Skeleton part of the
   animation workspace) and pick the **Reactions** tab.
2. Open **Test bench**, choose a scenario and press play. Shoot the character with the mouse.
3. Press **Customize** (or **From a preset**) to give the skeleton a set of its own, then tune it while the
   bench runs: every change applies to the next run.
4. On each placed character, its Skeleton section's [This character](node-inspector.md#this-character)
   rows pick which set it uses, how strong it is and whether it gets up.

## How a reaction runs

A character with no reaction running is plain animation and costs nothing. The moment something happens to
it, a powered ragdoll is made from the pose it holds, and the reaction moves through these states:

| State | What happens |
|---|---|
| animated | Plain animation. No bodies exist. |
| hitReact | A hit it stays standing through: the animation keeps the legs and the hips, the struck part goes weak and snaps away, a hand goes to the wound. |
| stagger | Off balance: the legs step to stay up, tiring with each step, until it stands or falls. |
| falling | Off its feet: it braces, covers its head, lands on bent knees or flails on a long drop. |
| tumble | Rolling down stairs, a slope or away from a vehicle: curled up, head covered. |
| down | Lying on the ground. It may writhe for a while if it was hurt. |
| getUp | Getting up, face up or face down, on a get-up clip or pulled up by its strings. A hit or a shove knocks it back: it staggers, or falls if it was not up yet. |
| recover | Back on its feet: the skin blends from the body to the animation. |
| dead | Killed: limp, and stays down. |

While a character is off its feet its Collider is turned off and follows its hips along the ground, so a
camera that follows the character follows the body. It is turned back on where the body stands up. Staggering,
the character also turns with its hips, so the animation the muscles reach for turns with the body.

While a reaction has the body, foot placement and foot locking fade out (in 0.15 s), and so does the support
hand's IK: feet planted by IK, or a hand held on a weapon's grip, would fight the body. They fade back in (in
0.35 s) once it is back on its animation, starting over rather than from where they were. A flinch it stands
through keeps foot placement.

Scripts hear each step as a `reaction:*` event (see [Reactions (scripting)](../scripting/reactions.md#events)).

## Reaction sets

A skeleton holds any number of named reaction sets: a soldier and a civilian can share one rig and react
differently. Each placed character picks one in its Properties, or takes the skeleton's default.

| Control | What it does |
|---|---|
| **Customize** | Gives the skeleton its own set, starting from the built-in Default. Until then the tab shows the built-in numbers read-only. |
| **From a preset** | Gives the skeleton its own set starting from a ready-made one (see below). |
| **New** | Adds another set, from a preset. |
| **Default** | Marks the set being edited as the one a character uses when it names none. Without one, the first set is the default. |

The duplicate button copies the set being edited; the delete button removes it (deleting the last set
returns the skeleton to the built-in Default). Double-click the set list to rename the set.

The presets:

| Preset | What it is |
|---|---|
| Default | An ordinary adult. |
| Tough | Strong and hard to topple: shrugs off small hits, steps more, falls later. |
| Wounded | Already hurt: weak, topples easily and writhes when down. |
| Drunk | Loose and unsteady: big staggers, slow arms, a long time to get up. |
| Stiff | Tense and rigid: a soldier, a robot. |
| Loose | Soft and floppy: a toy, a body barely conscious. |

Sets are saved with the skeleton and embedded in every model on it, in scenes, templates and the published
game, the same way as its ragdoll profile.

## Muscles

How firmly each part of the body holds the pose it is asked for, by region: neck and head, spine, arms,
hands, legs and feet. A muscle is a spring toward its pose; its stiffness is a frequency, so it reads the
same on a light body as on a heavy one.

| Setting | What it does |
|---|---|
| **Overall strength** | Multiplies every muscle of the set: above 1 a tough character, below 1 a weak one. A character's own **Reaction strength** multiplies it again. |
| **Stiffness** | How firmly the muscles hold their pose, in Hz: about 1 is a relaxed limb, 4 a tense one, 10 rigid. |
| **Damping** | Damping ratio: 1 reaches the pose without overshooting, less swings past it, more is sluggish. |
| **Strength** | The most the muscles can push with, in N·m for a 70 kg body (heavier bodies scale it up): what a fall or a hit overpowers. |
| **Hold up** | How much of their own weight the muscles hold up, 0 to 1. Below 1 a limb sags toward the ground. |

The defaults are Euphoria's stiffnesses (in rad/s, divided by 2π for Hz):

| Region | Stiffness | Strength |
|---|---|---|
| Neck and head | 2.23 Hz | 40 N·m |
| Spine | 1.75 Hz | 250 N·m |
| Arms | 1.59 Hz | 80 N·m |
| Hands | 1.43 Hz | 12 N·m |
| Legs | 2.07 Hz | 250 N·m |
| Feet | 1.91 Hz | 120 N·m |

## Strings

The strings hold a character on its animation while it stays on its feet: an invisible pull on each part
toward where the animation has it, which a hit loosens and which comes back over time. They are what keeps
a flinch from turning into a fall. Once a character is falling they let go.

| Setting | What it does |
|---|---|
| **Pull** | How firmly the strings pull a hit character back onto its animation, in Hz. |
| **Damping** | Damping ratio of the pull. |
| **Force** | The most each part may be pulled with, in N for a 70 kg body. |
| **Turn** | The most each part may be turned with, in N·m. |
| **Regain** | How fast a hit part takes its strings back, per second: 1 is all of them in a second. |
| **Legs** | How firmly the legs stay on the animation while the upper body takes a hit, 0 to 1. |

## Thresholds

What a hit, a shove or a fall must reach to move a reaction on to its next state.

| Setting | What it does |
|---|---|
| **Smallest hit** | A hit softer than this, in N·s, is ignored. |
| **Stagger at** | A hit at least this hard knocks the character off balance: it steps to stay up. |
| **Stumble at** | A hit on the trunk at least this hard, in N·s (a rifle round), rocks the hips back: it stumbles a step or two to stay up while its hand goes to the wound. 0 turns it off. |
| **Stumble speed** | How fast a stumbling hit sends the hips back, in m/s. |
| **Fall at** | A hit at least this hard knocks it straight down. |
| **Knocked out** | How far, in metres, the hips may be pushed from where the animation has them before the character falls. |
| **Fallen** | Below this uprightness (1 standing, 0 lying) a character that is off balance counts as falling. |
| **High fall** | A drop at least this high, in metres, is a fall from height: arms and legs flail on the way down. |
| **Tumbling** | Turning faster than this on the ground, in rad/s, counts as tumbling (stairs, a slope, a bail at speed). |
| **Lying still** | Slower than this, in m/s, a fallen body is down. |
| **Settled** | Slower than this for **Settle time**, a body lying down has come to rest. |
| **Settle time** | How long a body must stay still to count as at rest. |
| **Give up after** | A reaction that has not ended after this many seconds ends: the body lies where it is or gets up. |

For scale: a pistol round is about 5 to 20 N·s, a punch 20 to 40, a shotgun at close range or a car's
bumper well over 150.

## Behaviours

The reflexes. Each one runs in the states it belongs to, when its moment comes, on the parts of the body it
moves, fading in and out; several can run at once (a falling body braces with its arms while it tucks its
chin). Each has a switch in its header: off, it never runs. Behaviours that take a **pose** can be given one
from the skeleton's pose library, and those that take a **clip** one of the skeleton's clips (see
[Poses and clips](#poses-and-clips)).

### Hit reaction

A hit the character stays standing through: the struck part goes weak and snaps away from the hit, the head
turns to the wound and the free hand reaches for it and holds it.

| Setting | What it does |
|---|---|
| **Weakness** | How much strength the struck part keeps at first, 0 to 1 (1 is none lost). |
| **Recover in** | How long the struck part takes to get its strength back. |
| **Snap** | An extra jolt to the spine and neck, away from the hit. |
| **Reach after** | How long before a hand goes to the wound. |
| **Hold for** | How long a hand holds the wound. |
| **Reach** | The farthest a hand reaches for a wound, in metres; beyond it, it does not try. |
| **Reach stiffness** | How firmly the reaching arm holds the wound. |
| **Reach pull** | How firmly a string draws the hand onto the wound, as a share of the **Strings** (0: the muscles of the arm alone). While it reaches, the forearm and the hand pass through the rest of the body. |
| **Look for** | How long the head turns toward the wound. |
| **Lasts** | How long a hit reaction runs before the character is back on its animation. |
| **Flinch** | Pose: the body's recoil from a hit, blended in for a moment (spine, neck, arms). |

A wounded arm is not used to reach: the other hand goes to it, across the body if it has to.

### Step to balance

Off balance but not falling: the legs step to where the body's momentum says it must stand (its capture
point), up to a few steps, the legs tiring with each one, then it falls.

| Setting | What it does |
|---|---|
| **Steps** | How many steps it takes before it gives up and falls. |
| **Step time** | How long one step takes. |
| **Step height** | How high a stepping foot lifts. |
| **Longest step** | The longest step a leg can take. |
| **Margin** | How far inside its feet, in metres, the capture point must stay before no step is needed. |
| **Leg stiffness** | How firmly the legs hold their steps at first. |
| **Tiring** | Leg stiffness kept after each step: 0.8 loses a fifth per step. |
| **Arm stiffness** | How loose the arms go while it staggers. |
| **Upright help** | How much the hips and chest are helped to stay upright, gone by the last step. |
| **Lean** | How far the body leans the way it is going, in radians. |
| **Give up at** | Below this uprightness it stops stepping and falls. |
| **Recovered after** | How long it must stand balanced to be back on its animation. |

The **capture point** is where a body must put its foot to stop: its centre of mass plus its velocity times
√(height ÷ g). The bench's **Balance** overlay draws it.

### Catch the fall

Falling toward the ground: the hands reach for where the body will land, one after the other, the elbows
give on impact and the knees bend.

| Setting | What it does |
|---|---|
| **Sees ahead** | How far ahead, in seconds, it looks for the ground it will hit. |
| **Second hand** | How long after the first hand the second reaches. |
| **Arm stiffness** | How firmly the arms brace. |
| **Give for** | How long the arms give after the hands touch down. |
| **Give** | Arm stiffness kept while they give. |
| **Reach ahead** | How far ahead of the shoulders the hands go. |
| **Knee bend** | How far the knees bend to meet the ground, in radians. |
| **Brace** | Pose: arms and legs readied for the ground; the hands still go where the fall lands. |

### Protect the head

Falling head first, tumbling or rolling down stairs: the arms come up round the head and the chin tucks in.

| Setting | What it does |
|---|---|
| **Chin tuck** | How far the head bends forward, in radians. |
| **Neck stiffness** | How firmly the neck holds it. |
| **Arm stiffness** | How firmly the arms hold round the head. |
| **Hands apart** | How far beside the head the hands go. |
| **Fade** | How fast it comes and goes. |
| **Protect head** | Pose: arms round the head, used instead of the hands going beside it. |

### Land

Coming down feet first and upright: the knees and hips bend just before touchdown and soften to take the
impact.

| Setting | What it does |
|---|---|
| **Ready** | How long before touchdown the legs get ready. |
| **Upright enough** | Less upright than this, it does not try to land on its feet. |
| **Knee bend** | How far the knees bend, in radians. |
| **Hip bend** | How far the hips bend, in radians. |
| **Soften for** | How long the legs soften after touchdown. |
| **Survivable** | Landing faster than this, in m/s, the legs give way. |
| **Landing** | Pose: the bent-knee pose to land in, used instead of the knee and hip bend. |

### Fall from height

A long drop: the arms windmill and the legs pedal on the way down, or a falling clip plays.

| Setting | What it does |
|---|---|
| **After** | How long the body must have been falling first. |
| **Arm speed** | How fast the arms circle, in rad/s. |
| **Arm swing** | How wide the arms circle, in radians. |
| **Leg speed** | How fast the legs pedal, in rad/s. |
| **Leg swing** | How wide the legs pedal, in radians. |
| **Stiffness** | How firmly the body moves while it flails. |
| **Falling** | Clip: a falling clip played (looped) instead of the windmill. |

### Tumble

Rolling down stairs or a slope: the body curls up, keeps rolling rather than sliding, and the arms spread to
stop it once it has slowed.

| Setting | What it does |
|---|---|
| **Stiffness** | How firmly it holds the curl. |
| **Damping** | Damping ratio while curled. |
| **Curl** | How far the spine, hips and knees fold, in radians. |
| **Roll** | How much it is helped to keep rolling down the slope. |
| **Spread below** | Below this speed, in m/s, the arms spread to stop it. |
| **Curl pose** | Pose: the tucked pose to tumble in, used instead of the curl. |

### Bail out

Thrown from a moving vehicle: it leaves with the vehicle's speed, passes clear of the vehicle for a moment,
braces for the ground, then tumbles.

| Setting | What it does |
|---|---|
| **Keeps speed** | How much of the vehicle's velocity it leaves with. |
| **Thrown out** | How fast it is thrown out through the door, in m/s. |
| **Thrown up** | How fast it is thrown upward, in m/s. |
| **Clear for** | How long it passes through the vehicle it left. |

### Struck

Hit by a vehicle (a script's `impact()`, see [Reactions (scripting)](../scripting/reactions.md)): the legs are
taken out at the vehicle's speed and the trunk is thrown less and upward, so the body pivots over what hit it. It
braces as it goes: the knees and hips bend, the trunk curls, and the arms come up round the head (**Protect the
head** runs with it).

| Setting | What it does |
|---|---|
| **Knee bend** | How far the knees bend, in radians. |
| **Hip bend** | How far the hips bend, in radians; the trunk curls a third of that. |
| **Stiffness** | How firmly it holds the brace. |
| **Lasts** | How long it braces; the head stays protected a little longer. |
| **Legs taken** | How much of the vehicle's speed the legs take. |
| **Trunk thrown** | How much of it the trunk takes: less than the legs, so the body pivots over. |
| **Thrown up** | Upward speed given, as a share of the vehicle's. |

### Writhe

Lying hurt: slow, weak movement with a hand on the wound, or a clip played softly.

| Setting | What it does |
|---|---|
| **Stiffness** | How firmly it moves. |
| **Damping** | Damping ratio. |
| **Period** | How long one roll of the body takes. |
| **Amplitude** | How far it rolls and bends, in radians. |
| **Lasts** | How long it writhes before lying still or getting up. |
| **Writhing** | Clip: played softly (looped) as its movement. |

It runs only for a character that was hurt (hit) before it went down.

### Relax

Unconscious or dead: the muscles let go, with a little friction left in the joints.

| Setting | What it does |
|---|---|
| **Strength** | Muscle strength kept, 0 to 1. |
| **Friction** | Joint friction, in N·m: how fast a limp limb stops swinging. |

### Get up

At rest on the ground and still able: it plays a get-up clip from where it lies, face up or face down, the
body following the clip until it stands.

| Setting | What it does |
|---|---|
| **After** | How long it lies still first. |
| **Strength** | Muscle strength while it gets up. |
| **Regain** | How long its strings take to pull it fully onto the clip. |
| **Blend** | How long the skin takes to go from the body onto the clip's first frame at the start (and, without a clip, from the body to the animation at the end). |
| **From the back** | Clip: the clip to get up with lying face up. |
| **From the front** | Clip: the clip to get up with lying face down. |

Face up or face down is read from the hips and the chest together. The clip is lined up with the body, not
the body with the clip: the character is turned about the vertical so the clip's hips lie the way the body's do,
and placed where the body lies. The clip then waits on its first frame for **Blend** while the skin blends from
the body onto it, and plays. Without clips the strings lift the body back onto the animation it was playing,
which works but looks like a puppet; Mixamo's "Getting Up" (face down) and "Stand Up" (face up) imported onto the
skeleton work well. A character whose **Gets up** is off, or that is dead or knocked out, stays down.

A hit or a shove while it gets up stops the clip: it staggers if it was up far enough, and falls if not.

## Poses and clips

Behaviours with a pose slot (**Flinch**, **Brace**, **Protect head**, **Landing**, **Curl pose**) use the pose you
give them in place of their own built-in shape, from the skeleton's pose library ([Poses](animation.md#poses)).
The pose is what the muscles reach for; the behaviour still decides when, how strongly and, for the hands,
where. An edit to the pose updates every set that uses it.

Clip slots (**Falling**, **Writhing**, **From the back**, **From the front**) pick one of the skeleton's
clips. A clip plays in the animator's `Reaction` slot as the pose the muscles follow.

The bench's capture button turns the pose the simulated body holds into a new pose in the skeleton's pose
library: pause a fall at the moment the body looks right and capture it, then give it to a slot.

## The test bench

The bench runs the set being edited on the preview character in the viewport, live: pick a scenario, press
play, and shoot, shove or trip the character; every change to the set applies to the next run. It works on
every physics backend, with the physics worker on or off.

| Scenario | What it is |
|---|---|
| Flat ground | Open ground: shoot it, push it, trip it, throw it. |
| Stairs | Standing at the top of a flight of stairs, tripped down them. |
| Ramp | Standing at the top of a slope, tripped down it. |
| Ledge | Stepping off a ledge of the height set. |
| Moving vehicle | Riding a flat-bed cart at the speed set, then bailing out of it sideways. |
| Wall | Shoved into a wall. |

| Setting | What it does |
|---|---|
| **Steps** | Stairs: how many steps the flight has. |
| **Rise** | Stairs: how high each step is. |
| **Run** | Stairs: how deep each step is. |
| **Slope** | Ramp: how steep it is, in degrees. |
| **Drop** | Ledge: how high it is. |
| **Speed** | Moving vehicle: how fast the cart goes, in m/s. |
| **Impulse** | How hard a shot, a click-shove or the hit button lands, in N·s. |
| **Target** | Draws the pose the muscles reach for, as ghost outlines of the body parts. |
| **Balance** | Draws the centre of mass and the capture point. |
| **Impact** | Draws where the fall will land, as the body's predicted path meets the ground. |

The controls, left to right:

- **Run** starts the scenario (again, from the start, while one runs); **End** removes the props and puts
  the character back on its animation.
- **Pause** and **One frame forward**; **1× / 0.5× / 0.25× / 0.1×** slow the bench's clock down.
- The mouse tool: **Shoot** (a click hits the part under the mouse, with the **Impulse** set),
  **Shove** (a click pushes that part) or none (clicks go to the viewport as usual).
- The actions: hit in the chest, shove, trip, fall, bail out, knock out, kill, get up.
- **Capture** saves the pose the body holds now into the pose library (see [Poses and clips](#poses-and-clips)).

Under the controls, the reaction's state, the behaviours running and how strongly, and its health. The
**timeline** below them holds the last 20 seconds: the state on top, then a row per behaviour, as bright as
it ran. Click or drag on it to pause and replay that moment; the body is put back where it was then. Resuming
simulates on from there, which is close to, but not exactly, what happened the first time.

## On a character

Each placed character decides for itself, in its Skeleton section's
[This character](node-inspector.md#this-character) rows: which set it uses (**Reactions**, or **Off** for none),
**Reaction strength**, **Health** and **Gets up**. Scripts can change all of them at runtime.

## Physics backends

Reactions run on all three physics backends and with the physics worker on or off.

- **Jolt** drives the muscles with its own joint motors.
- **cannon-es** drives them with motor constraints solved with the joints. Its contacts are stiffer than the
  others', so a hand reaching across the body for a wound passes through the chest on its way (on every backend)
  rather than being held off it, and lands a little less exactly.
- **Rapier** drives them with the engine's shared muscle solver, and doubles its substeps while a powered
  ragdoll exists, which costs some time. Its muscles are a little softer than the other two's: a falling
  body's arms brace a little later.

The three feel alike but are not identical: a set tuned on one may want small changes on another. See
[Physics backends](../reference/physics-backends.md#joint-drives).

## Tips

- **Tune on the bench at 0.25×.** Most of what makes a reaction read happens in the first half second.
- **Raise Stiffness before Strength.** A limb that will not hold its pose is usually too soft, not too weak;
  Strength is what a hit or the ground overpowers.
- **Keep the ragdoll's twist limits realistic** (in the Ragdoll tab). A muscle cannot reach a pose its joint
  will not allow; targets are clamped to the joint's cone and its twist, measured from the bind pose. The automatic
  humanoid twists its spine and chest 20 degrees each, its neck 40.
- **Give the ground grip.** A body rolls on ground with grip and slides on slick ground: a pair of surfaces takes
  the smaller friction, and the automatic humanoid's parts have 0.8.
- **A pose slot is a shape, not a placement.** Hands and feet still go where the behaviour sends them.

## See also

[Physics](physics.md) · [Reactions (scripting)](../scripting/reactions.md) · [Reactive ragdolls reference](../reference/reactive-ragdolls.md) · [Animation](animation.md) · [Node inspector](node-inspector.md)
