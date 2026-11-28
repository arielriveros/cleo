# Reactions

How characters on a skeleton react with their whole body when they are shot, shoved, trip, drop off a
ledge, tumble down stairs or are thrown from a moving vehicle, and how they get up again. The body is a
**powered ragdoll**: physics moves it, but every joint has a muscle pulling it toward a pose, so it can
flinch, stagger, brace for the ground, cover its head, bend its knees to land, hold a wound and stand back
up. It is authored on the skeleton, in the **Reactions** tab beside its [Ragdoll](physics.md#the-ragdoll-panel-rig-editor)
tab, and tried on the tab's [test bench](#the-test-bench).

Reactions run on the **Jolt** physics backend only, the default (see [Physics backends](#physics-backends)). On
cannon-es or Rapier characters do not react, and the Reactions tab shows a warning above its controls, every one
of them off.

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
| hitReact | A hit it stays standing through: the legs and hips stay on the animation, the upper body sways after the hit on top of what the animation does, a free hand goes to the wound. It keeps its control. |
| stagger | Knocked back on its feet: the character is shoved (its capsule carries it, its legs walking it out on their animation), the upper body leaning after the hit. It keeps its control; tipped too far, it falls. |
| falling | Off its feet: it braces, covers its head, lands on bent knees or flails on a long drop. |
| tumble | Rolling down stairs, a slope or away from a vehicle: curled up, head covered. |
| down | Lying on the ground. It may writhe for a while if it was hurt; about to get up off its front or side, it rolls onto its back. |
| getUp | Getting up, face up or face down, on a get-up clip or pulled up by its strings. A hit or a shove knocks it back down. It has no control until the get-up is over (its clip and the blend after it). |
| recover | Back on its feet: the skin blends from the body to the animation (on its feet, once the upper body follows the animation closely). |
| dead | Killed: limp once it is on the ground, and stays down. |

Off its feet (falling, tumbling, lying, dead) the body is alive: its muscles follow a pose of their own, never
merely holding wherever the limbs already are. Falling, that is the pose it fell in, easing toward a brace (knees,
hips and elbows a little bent); a clip playing as the body's (a [Fall from height](#fall-from-height) or
[Writhe](#writhe) clip, or a [Ragdoll state](animation.md#ragdoll-and-get-up-states)'s own) takes it over; lying,
it is the pose it came to rest in, let go once it lies still. Every behaviour bends, tucks and reaches on top of
that pose, and every muscle is at least critically damped, so a limb settles rather than rings. A part pressed into
the ground far from its pose gives way to it.

### On its feet: physical animation

A character flinching or staggering is never taken out of the game: it keeps its Collider and its control, so
it goes on walking, running, aiming and firing while it reacts. It is the model of Unreal's Physical Animation
and of PuppetMaster, on Jolt's ragdoll tools:

- **The legs and hips are the animation's.** They are kinematic bodies moved every step to where the animation
  has them (`PhysicsBody.setType`, Jolt's kinematic motion), so they push what they meet and nothing pushes them,
  and foot placement stays on (its rays pass through the character's own body). Foot locking does too, except while a stagger's shove slides the character: then the feet follow the animation rather than stay planted. Nothing of the reaction fights the legs.
- **The upper body follows the animation on firm muscles** (**Tracking**, 6 Hz by default), with the animation's
  own motion: each muscle is given the speed its target turns at, and Jolt's motors drive position and velocity
  together, so a swinging arm or an aim is followed within a few degrees instead of trailed. A hit is a kick to
  the struck part (no more than **Kick**) and a short weakness of that part alone: a sway on whatever the animation
  does, that the muscles take back.
- **The upper body is drawn against the hips.** The simulated chest, arms and head are placed on the hips as the
  animation has them that frame, so the waist never tears however the physics lags the skin.
- **A stagger steps on legs of its own.** For a [stagger](#stagger) the legs and hips become the physics' and
  take short quick steps to keep the body up; the capsule follows the body (`CharacterNode.followBody`) instead of
  walking, and its walk still turns and aims it. Caught, the character is put where the body stands and the legs
  go back to the animation.
- **Hits add up.** A burst counts its last second's hits together: enough of them stagger it like one hard hit,
  more knock it down.
- **A hand on a weapon stays there.** Only a free hand reaches for a wound. A hand is busy while the animator's
  support-hand IK holds a weapon in two hands, or as a script says (`reactions.busyHands`); a busy arm is drawn a
  little closer to its animation so it stays on its grip.

Off its feet (falling, rolling, lying, getting up) the body has every part. Its Collider is turned off and
follows its hips along the ground, so a camera that follows the character follows the body; it is turned back
on where the body stands up. A falling body stays alive: its muscles start as firm as they were on its feet and
tire over a couple of seconds, while it braces, covers its head or lands. Foot placement and foot locking fade
out (in 0.15 s), and so does the support hand's IK; they fade back in (in 0.35 s) once it is back on its
animation.

Scripts hear each step as a `reaction:*` event (see [Reactions (scripting)](../scripting/reactions.md#events)).

## What a reaction costs

A reacting body is 16 simulated parts, their joints and muscles, and the senses that tell it where it is going.
Many at once is a lot of work, so the engine keeps it in check:

- **A budget.** At most **Reacting bodies** characters (Options ▸ Engine ▸ Physics, 6 by default) have their
  body at once. A hit that would only make one flinch or stumble while that many are reacting, or more than 40 m
  from the camera, moves nothing: the hit still counts (its `reaction:Hit` event, the scripts reading it). A fall
  always gets its body, taking it from the farthest character that is only flinching.
- **Rest.** A body lying still has nothing to do until it gets up: its parts leave the simulation, holding the pose
  where it lies, and come back the moment it gets up or something hits or shoves it. It does not count against the
  budget.
- **Its own solver iterations.** A chain of 16 jointed parts needs more solver iterations than a crate. Its
  joints ask for them for their own island alone (the ragdoll profile's **Solver iterations**): the world's count
  stays what it is.
- **Senses on demand.** Where a fall will land (up to 20 rays) and the ground ahead (4) are measured only in the
  air or rolling; the ground under it every step while it stands or falls, every fourth lying or getting up. The
  step's contacts are sorted out once for every reacting body.
- **The animation underneath.** While the body has every part (falling, rolling, lying) the animation its weak
  muscles reach for is posed every other frame; a layer that is not drawn poses nothing.

The Performance panel's physics rows show the time reactions take, the bodies reacting and their rays
(`physics.stats.reactionsMs`, `poweredRagdolls`, `sensorRays`).

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
| **Stagger at** | A hit at least this hard, in N·s (or a burst adding up to it within a second), knocks the character back on its feet: it is shoved, its legs carrying it, and keeps its control. |
| **Stumble at** | A hit on the trunk at least this hard, in N·s (a heavy round), rocks the body back: a short shove it walks out of. 0 turns it off. |
| **Stumble speed** | How fast a stumbling hit shoves the character back, in m/s. |
| **Fall at** | A hit at least this hard knocks it straight down. |
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

A hit the character stays standing through: the struck part sways from the hit and goes weak for a moment, the
spine snaps away from it, the head turns to the wound and a free hand reaches for it and holds it, all on top of
what the animation does.

| Setting | What it does |
|---|---|
| **Weakness** | How much strength the struck part keeps at first, 0 to 1 (1 is none lost). On its feet only that part weakens. |
| **Recover in** | How long the struck part takes to get its strength back. |
| **Tracking** | How firmly, in Hz, the upper body follows the animation while the character stands (the arms a little less, the hands less again). |
| **Tracking strength** | The muscles' strength while it stands, as a multiple of the set's **Strength**. |
| **Kick** | The most of a hit's impulse, in N·s, the struck part takes while the character stands; the whole hit still decides whether it stumbles or falls. |
| **Snap** | An extra jolt to the spine and neck, away from the hit. |
| **Reach after** | How long before a hand goes to the wound. |
| **Hold for** | How long a free hand holds the wound (a hand on a weapon does not leave it). |
| **Reach** | The farthest a hand reaches for a wound, in metres; beyond it, it does not try. |
| **Reach stiffness** | How firmly the reaching arm holds the wound. |
| **Reach pull** | How firmly a string draws the hand onto the wound, as a share of the **Strings** (0: the muscles of the arm alone). While it reaches, the forearm and the hand pass through the rest of the body. |
| **Look for** | How long the head turns toward the wound. |
| **Lasts** | How long a hit reaction runs before the character is back on its animation. |
| **Pain** | How far the spine bows over a hit to the chest or the gut, in radians, for as bad as it is: up in 0.2 s, held a second, easing off over 1.5 s. |
| **Shock spin** | How far a hit to the chest turns it, in radians, the way the hit pushes the side it struck. |
| **Gut fold** | How far a hit to the gut folds the body over it, in radians, for about two seconds. |
| **Back arch** | How far a hit from behind arches the back, in radians, for 0.7 s. |
| **Arm twist** | How far a hit to an arm turns the trunk with it, in radians; the arm goes loose a moment too. |
| **Knee gives** | How far a hit leg's knee gives (at 0.3 s), in radians, on legs of its own: in a stagger, or off its feet. |
| **Leg stagger** | A hit to a leg at least this share of the thresholds' **Stumble at** staggers it: the hit leg gives and it steps. |
| **Flinch** | Pose: the body's recoil from a hit, blended in for a moment (spine, neck, arms). |

A wounded arm is not used to reach: the other hand goes to it, across the body if it has to.

**Where it lands decides how it reacts** (Euphoria's shot behaviours). Every hit is read as one of six zones:
the **head** (the neck goes loose and comes back over 0.4 s, the snap is the neck's), the **chest** (it spins the
way the hit pushed the side it struck, and the spine bows in pain), the **gut** (it folds over the wound), the
**back** (a hit from behind arches it), an **arm** (the arm goes loose, the trunk turns with it, the other hand
holds it) and a **leg** (the leg gives: a hard enough one staggers it, the knee bending as it steps). A hit's kick
is shaped as a bullet's is: most of it at once where it struck, the rest along the spine over a tenth of a second;
on its feet a hit to a leg kicks the trunk's centre, never the chest at the leg's height. How bad a wound was keeps
it: a bad one stays longer (its hand, its pain), and of the four wounds kept the slightest goes first.
`reactions.pain` (0 to 1) is how much it hurts now, and the `Hit` event names the part and the zone.

### Stagger

Knocked back but on its feet: it steps to stay up, as Euphoria's balancer does. Its legs are the physics' for
the stagger (on their muscles, not the animation's), and it takes short, quick steps: each one aimed where the
body will be **Looks ahead** from now, beside the planted foot (never across it), no longer than **Step length**,
a foot lifting **Step height** and landing in **Step time**. Its legs tire with each step after the second, and a
hand keeps the trunk upright and the hips from sinking (**Help**, weakening as they tire). Caught (over its feet,
slow, for **Recovered after**), it is back on its animation where it stands. It gives up and falls after
**Steps** steps that have not caught it, leaning past **Falls past** for **For**, sinking to half its height, or
with its capture point far beyond its feet. It keeps its control throughout: its capsule follows the body, and
its walk still turns and aims it. Turning the behaviour off makes every hit that would stagger a flinch.

| Setting | What it does |
|---|---|
| **Shove lasts** | How long the upper body's lean after the shove takes to fade by half, in seconds. |
| **Lean** | How far the upper body leans back the way it is shoved, in radians. |
| **Looks ahead** | How far ahead of the body each step is aimed, in seconds: more makes fewer, longer steps. |
| **Step time** | How long a foot takes from lifting to landing, in seconds. |
| **Step height** | How high a foot lifts on the way, in metres. |
| **Step length** | The longest step it takes from the planted foot, in metres. |
| **Feet apart** | The least it steps out to its own side of the planted foot, in metres: it never crosses its feet. |
| **Widest step** | The most it steps out to the side, in metres. |
| **Steps** | How many steps it takes before it gives up and falls, if they have not caught it. |
| **Tires to** | The strength its legs keep with each step after the second (0.7: 70% of the step before). |
| **Help** | A hand keeping the trunk upright and the hips from sinking while it steps (0: its legs alone). |
| **Falls above** | A shove faster than this (m/s) knocks it straight down: no step could catch it. |
| **Falls past** | How far, in radians, the trunk may lean from upright before it falls. |
| **For** | How long it must lean that far to fall. |
| **Recovered after** | How long it must stand over its feet, slow, before it is back on its animation. |

How fast a stagger shoves the body is the thresholds' **Stumble speed**, more for a harder hit (up to two and a
half times), most of the walk it was taking braced against; the shove goes to the trunk and the arms, half of it
to the thighs and none to the shins and feet, so the legs are left behind and must step. A shove softer than a
stagger is a flinch: it never slides the character along the ground. The bench's **Balance** overlay draws the
body's centre of mass and its **capture point** (where a body must put its foot to stop: its centre of mass plus
its velocity times √(height ÷ g)). Scripts read the steps on `reactions.balance` (`steps`, `stepLengths`,
`swinging`, `gaveUp`), and `reactions.knockCount` counts every stagger and every fall from its feet.

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

Thrown from a moving vehicle: it leaves with the vehicle's speed and passes clear of the vehicle for a moment. In
the air it tucks into a ball, as a stunt performer jumping from a car does: knees and thighs folded up, the trunk
curled, the chin in, the elbows in. A moment before the ground its hands go to meet it ([Catch the fall](#catch-the-fall)),
or, coming down too fast for hands, its arms go round its head ([Protect the head](#protect-the-head)); it never
tries to land on its feet. Moving along the ground faster than **Rolls above** when it lands, it rolls on (a
[tumble](#tumble)) rather than stopping dead.

| Setting | What it does |
|---|---|
| **Keeps speed** | How much of the vehicle's velocity it leaves with. |
| **Thrown out** | How fast it is thrown out through the door, in m/s. |
| **Thrown up** | How fast it is thrown upward, in m/s. |
| **Clear for** | How long it passes through the vehicle it left. |
| **Knee tuck** | How far the knees fold in the air, in radians. |
| **Hip tuck** | How far the thighs come up toward the chest, in radians. |
| **Trunk curl** | How far each part of the spine curls forward, in radians. |
| **Chin in** | How far the head bends to the chest, in radians. |
| **Arms in** | How far the upper arms come in front of the chest, the elbows folded, in radians. |
| **Tuck stiffness** | How firmly it holds the tuck, in Hz. |
| **Hands down** | How long before it reaches the ground the hands go to meet it, in seconds. |
| **Too fast to catch** | Coming down faster than this (m/s), the arms go round the head instead. |
| **Rolls above** | Moving along the ground faster than this (m/s) when it lands, it rolls. |

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

Unconscious or dead, once it has come to rest: the muscles let go, with a little friction left in the joints. Dead,
they let go a moment after it reaches the ground; out cold, they keep at least a third of their strength until it
lies still. Until then it falls like a body, not a sack.

| Setting | What it does |
|---|---|
| **Strength** | Muscle strength kept, 0 to 1. |
| **Friction** | Joint friction, in N·m: how fast a limp limb stops swinging. |

### Roll over

Lying on its front or its side when it is time to get up: it rolls onto its back first, then gets up with the clip
for its back. The leg on the side that goes up crosses over and the arm on that side reaches over the body, the arm
underneath folds in, and the chest and the head lead the turn; the turn itself is driven about the body's length at
**Roll speed**, slowing to nothing as the body gets onto its back. Off, a body on its front gets up with the clip for
its front (**From the front**).

| Setting | What it does |
|---|---|
| **Twist** | How far the chest and the head lead the roll, in radians. |
| **Roll speed** | How fast it turns over, in rad/s (slowing as it gets onto its back). |
| **Tries for** | How long it tries, in seconds, before it gets up as it lies. |

How it lies is read from the front of its hips and its chest together, against up: more than 0.35 of the way up
is on its back, less than −0.35 on its front, between them on its side; once it is one it stays that until it is
well into the next, so a body rocking on the line does not flicker. Scripts read it as `reactions.lying`, and the
`Down`, `Settled` and `GettingUp` events carry it.

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

Face up or face down is read from the hips and the chest together (and with [Roll over](#roll-over) on, a body on
its front or side rolls onto its back first). The clip is lined up with the body, not the body with the clip: the
character is turned about the vertical so the clip's hips lie the way the body's do (along the hips' length, where
it lies flat), and placed where the body lies. The clip is joined where the body in it starts to rise: a
motion-capture get-up often lies still a second or more first, and played from its first frame the character would
lie there as though nothing were happening. It waits on that frame for **Blend** while the skin blends from the
body onto it, and plays. Without clips the strings lift the body back onto the animation it was playing,
which works but looks like a puppet; Mixamo's "Getting Up" (face down) and "Stand Up" (face up) imported onto the
skeleton work well. A character whose **Gets up** is off, or that is dead or knocked out, stays down.

A hit or a shove while it gets up stops the clip: it staggers if it was up far enough, and falls if not.

**The animator's graph can own the get-up instead.** While its base layer is in a
[Ragdoll state](animation.md#ragdoll-and-get-up-states) the body never gets up by itself, whatever **Gets up**
says; it rises when the graph enters a Get Up state, on that state's clips (these two when it names none), on the
base layer rather than the Reaction slot. Leave the Ragdoll state for any other and it gets up by itself again,
on these clips. The graph also sets how each of its states takes hits: [reaction effects](animation.md#reaction-effects).

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
Jolt, with the physics worker on or off.

| Scenario | What it is |
|---|---|
| Flat ground | Open ground: shoot it, push it, trip it, throw it. |
| Walking | Walking forward at the speed set while you shoot or shove it (play a walk on the preview to match): it keeps walking through a flinch or a stagger, the shove adding to its walk. |
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

Reactions run on **Jolt** only, with the physics worker on or off. Jolt drives the muscles with its own joint
motors, solved with the joints, which hold a body the way the sets are tuned for. On cannon-es and Rapier the same
sets looked wrong (cannon's stiff contacts, Rapier's softer muscles), so there:

- a character has no reactions (`physics.reactionsOf` gives `null`): a shot or a shove moves only what it strikes,
  and the log says once why;
- the Reactions tab shows a warning above its controls, every one of them off (its sets are kept, for when the
  project is back on Jolt);
- a ragdoll a script starts itself (a death's limp fall, `physics.startRagdoll`) still falls, on every backend.

Pick the backend in Options ▸ Engine ▸ Physics backend. A Jolt project that falls back to another backend (no
WebAssembly) has no reactions either. See [Physics backends](../reference/physics-backends.md#joint-drives).

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
