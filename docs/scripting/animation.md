# Animation

Driving a skinned model from code. Most animation is *authored* rather than scripted — a state
machine reading measured values off the node needs no script at all — so read
[Animation (editor)](../editor/animation.md) first and come here for the parts that need code.

```ts
const animator = (this.findNode('Model') as ModelNode).animator
```

An `Animator` exists on any `ModelNode` whose model is skinned.

## Playing a clip directly

```ts
playAnimation(index: number, loop = true, blend = true): void
playAnimationByName(name: string, loop = true, blend = true): void
play() / pause() / stop() / reset()
seek(time: number): void
showBindPose(): void

get isPlaying / currentTime / duration / currentAnimation / currentSpeed / isBlending
get/set loop / speed / blendTime
```

Direct playback is fine for one-offs — an emote, a door opening. For anything a character does
continuously, use a state machine: it handles blending, exit times and hysteresis for you. On a
character that already runs a state machine, play a one-off as an [action](#actions) instead — the
machine decides what plays, and an action is the way to put something on top of it.

## Driving a state machine

```ts
setFloat(name: string, value: number): void
setBool(name: string, value: boolean): void
setTrigger(name: TriggerName): void
resetTrigger(name: TriggerName): void
getParam(name: string): number | boolean | undefined

triggerInfo(trigger: string): AnimationTriggerInfo | null   // what firing it plays
activeTrigger(layer?: string): string | null                 // the trigger whose state a layer plays

get currentStateName: string | null
get hasStateMachine: boolean
resetStateMachine(): void
setStateMachine(sm: AnimationStateMachine | null): void
getStateMachine(): AnimationStateMachine | null
```

You often need none of this. A parameter can be **bound** in the editor to a node variable or to a
[built-in](../reference/animation-builtins.md), and then the machine reads the value itself every
frame — no script in the loop:

| Parameter | Bind to | Why |
|---|---|---|
| Speed | Built-in → Parent → `planarSpeed` | Measured, so a character against a wall reads 0. |
| Direction | Variable → Parent → `moveDir` | The strafe angle. |
| Jumping | Variable → Parent → `isJumping` | |

Use `setFloat` / `setBool` / `setTrigger` for game state the engine cannot measure — health,
weapon type, whether a door is locked.

```ts
onUpdate() {
  animator.setBool('Wounded', this.health < 30)
  if (this.justFired) animator.setTrigger('Fire')
}
```

A `trigger` parameter stays raised until the state or transition it starts fires, then is lowered, so
it cannot fire twice. [Layers](#layers) share the parameter table, and the lowering waits until the
base and every layer have evaluated that frame: a trigger two layers read fires both — a `Died` that
sends the base to Dead also takes an Actions layer out of its roll. One that nothing can take yet (its
transition waits on the clip's end, say) stays raised until something does; `resetTrigger` withdraws it.

**Triggers are names, checked.** In the editor's script editor and in the VS Code workspace, a
`TriggerName` — `setTrigger`'s argument, and any field typed `TriggerName` — must be one of the
triggers the project's animators declare: a misspelt one is an error, and the real names complete. The
editor writes them to `.cleo/types/project.d.ts` as the animators change; a project with no triggers at
all takes any string. In the inspector, a `TriggerName` field is picked from the character's triggers,
never typed.

**State groups.** A machine (and each layer) may group states, to keep a big graph readable and to share the
transitions its states have in common:

```ts
interface AnimationStateGroup { name: string; states: string[]; entry?: string; x?: number; y?: number }
interface AnimationStateMachine { groups?: AnimationStateGroup[] /* ... */ }   // AnimationLayer has groups too
```

- **Out of a group.** A transition whose `from` is a group's name fires from any of its states. A state's own
  transitions are tried first, so a state can override its group's way out.
- **Into a group.** A transition whose `to` is a group enters its `entry` state (its first, if none).
- **Names.** A state belongs to one group at most, and no group shares a name with a state.

`currentStateName` is always a state, never a group.

**Holding the character still.** A state with `holdMovement: true` stops the character's own movement while it
plays: the [Character](characters-and-controllers.md) above the model steers as if its input were zero, with no
acceleration ramp and no facing turn, so its ground speed goes to 0 at once and gravity carries on. The clip's
root motion still moves it. A hard landing that crouches where it came down, whatever the stick says, is the
case. The animator reaches the Character as root motion reaches its body: the first ancestor with an
`animationHold` field (`CharacterNode.animationHold`, set each frame, read-only to scripts).

**Sync groups.** States that share a `syncGroup` hand over in step:

```ts
{ name: 'Locomotion', field: walk, syncGroup: 'Gait', ... }
{ name: 'Stairs', field: climb, syncGroup: 'Gait', ... }
```

- **The phase.** A transition between two of them starts the state entered at the normalized phase the one it left
  was at: a blend space's phase, or a looping clip's time over its length. Anything else starts at 0, and so does a
  re-entry of the same state.
- **The blend.** Through the cross-fade the two blend spaces share that phase, advanced at the rate of their mixed
  cycle (the outgoing one's length mixed into the incoming one's by the blend's progress). `fieldDebug.synced` is
  true meanwhile, and `fieldDebug.previousPhase` reads the outgoing side's phase (equal to `phase` when synced).
- **The feet.** It lines the feet up only if phase 0 is the same foot's plant in every state of the group (set
  each sample's `phaseOffset`).
- **Exit times** and `loopCount` count from the carried phase.
- **Interrupted.** A synced cross-fade interrupted by another freezes as any does; the next state still starts at the
  live phase.
- **Layers.** A layer's state in the group the base layer's current state is in FOLLOWS the base: every frame it takes
  the base's phase, through its own clip's length, so an upper-body layer (a weapon held over the stride) keeps step
  with the legs. When the base comes back into the group at another phase (from a start or a stop), the layer
  cross-fades to it over 0.2 s from the pose it was showing. While the base is outside the group the layer runs on its
  own clock. `animator.layerPhase(name)` reads where a layer is. Never put a held layer state (speed 0, a blend space
  of aim or look poses) in a group: following would move it.
- **Not a state group.** `syncGroup` shares a stride; `groups` share transitions.

A character running a [shared animator](../editor/animation.md#shared-animators) holds a resolved
copy of it, so all of the above works the same either way.

**Clips that come later.** A model on its skeleton's shared clips is built with none: they are attached after it
is parsed. A machine set while the model has no clips at all reports nothing, and is entered again, its layers
rebuilt and its parameters kept, the first frame the clips are there. A model that has clips but lacks the one a
state names still warns. `getStateMachine()` returns that copy; its
`controllerId` says which shared animator it came from.

## Layers

A machine's layers above the base each run their own states over the shared parameters. They are
authored in the editor ([Layers and bone masks](../editor/animation.md#layers-and-bone-masks)); a
script mostly just reads them, or fades one in and out:

```ts
setLayerWeight(layer: string, weight: number): void   // 0..1
layerStateName(layer: string): string | null          // the base layer's is currentStateName
layerStateTime(layer: string): number                 // clip seconds into its state's clip (0: none)
layerStateDuration(layer: string): number             // that clip's length (the base's: duration)
get layerNames: string[]                              // in order, base excluded
```

```ts
onUpdate() {
  // Raise the upper-body aim layer while the weapon is drawn.
  animator.setLayerWeight('Aim', this.weaponDrawn ? 1 : 0)
}
```

A layer whose weight is driven by a parameter ignores `setLayerWeight` — the parameter wins. Set the
parameter instead.

**A blend space on a layer.** A layer's state can be a [blend space](#blend-spaces), as a base state can. On an
**additive** layer each sample adds what it moves over its own first frame, mixed by the samples' weights. A
look-at is the usual case: pose clips (rest at frame 0, the look after it) at the corners and edges of a yaw x pitch
range, the axes reading where the aim is off the body, the weight up while the character stands still.

Play such a blend space at **speed 0**, with each sample's `phaseOffset` at 0.5: its poses are then sampled half way
in and held, and its weights still follow the axes every frame. Looping instead, it wraps back to the clips' first
frame (the rest the delta is taken from) once a cycle, and the pose snaps toward centre for a few frames. A state
held at speed 0 still blends in over its transition's seconds.

**Poses on layers.** A blend space can hold poses instead of clips (see [Blend spaces](#blend-spaces)): no phase, no
clip-length trick. A pose VARIANT on an additive layer adds what it changes from its base pose, so an aim offset is an
aim pose and its directions as variants, and an edit to the aim pose moves every direction.

```ts
interface AnimationState {
  // ...
  pose?: AnimationPose      // hold this pose (embedded from poseRef by the editor)
  meshSpace?: number        // Steady, on an override layer: 0..1, how much the pose keeps its own model-space turn
}
interface AnimationLayer {
  // ...
  handIk?: { hand: 'left' | 'right'; weight?: number; weightParam?: string; socket?: string }
}
interface AnimationPose {
  name?: string
  bones: { name: string; rotation?: number[]; translation?: number[] }[]   // deltas from rest, parent frame
  reference?: AnimationPoseBone[]   // what an additive layer measures it from: a variant's base (absent: rest)
  base?: string                     // in a blend space's pose table only: the key of the pose it is a variant of
}
```

- **Steady** (`meshSpace`): at each entry bone of the layer's mask (a masked bone whose parent is not, the Spine
  of an upper-body mask) the pose is turned so the bone faces as the pose itself has it in model space (its own
  hips; a bone it does not hold, at rest), measured against the body as the layers below compose it. 1 holds a
  rifle's chest still over any gait; 0 rides the hips. Eased over the state's transition.
- **Hand IK** (`handIk`): after every layer, before foot IK, that hand is moved by two-bone IK (keeping its
  elbow's bend plane) to where the layer's OWN pose puts it relative to the other hand, or onto `socket`, by
  `weight` (or `weightParam`) times the layer's weight and presence.
- `animator.updateStateMachine(sm)` swaps in an edited copy of the machine playing now without restarting it
  (the same parameters, layers and states; anything else falls back to `setStateMachine`): the editor's pose
  mode drags through it. `animator.posedLocal(nodeIndex)` reads a bone's final local of the last pose.

## One-shots in the graph

An attack, a roll or a hit reaction can be a state of an **Actions** layer — full body, above every
other layer, resting in an empty state — that its trigger enters directly
([how to build one](../editor/animation.md#one-shots-as-an-actions-layer)). The script fires the
trigger by name and names nothing else — no clip, no state, no layer; the graph owns the clip, its
speed, its start and its blends, and the animator answers what a trigger plays:

```ts
onUpdate(delta: number) {
  // Taken by the animator later in the frame it is set; from the next frame on, activeTrigger reads
  // Roll on its layer until the state it started leaves on its own at the clip's end.
  const roll = animator.triggerInfo('Roll')
  if (this.rolling && animator.activeTrigger(roll?.layer) !== 'Roll') this.rolling = false
  if (this.rolling) this.rollBy(animator.consumeRootMotion(), delta)   // the Roll state's extracted travel
  else if (Input.started('Roll')) { animator.setTrigger('Roll'); this.rolling = true }
}
```

```ts
interface AnimationTriggerInfo {
  layer: string | null      // null: the base
  state: string             // the state it enters
  clip: string; clipLength: number
  speed: number             // the state's rate now, × its speed-multiplier parameter
  startTime: number
  seconds: number           // real seconds until the layer rests or waits on another trigger
  extractsRootMotion: boolean
  fromAnywhere: boolean     // false: only from certain states, at their time (a combo's next segment)
}
```

- **When it ends.** `seconds` is its length — to where it hands over on another trigger, else to its
  clip's end, plus whatever it flows into by itself (a sheathe going on into the draw). `activeTrigger`
  stops reading it once the layer is back at rest or another trigger took over. On the frame
  `layerStateTime` reaches `clipLength`, a transition that waits for the clip end has not fired yet — a
  script turning the body round at the end of a turn clip does it then, and the cut lands on the same
  frame.
- **Frame order.** A character's script runs before its model's animator in the same frame, so a
  trigger set in `onUpdate` is taken that frame.
- **Root travel.** A layer state with **extract root travel** collects its clip's ground travel for
  `consumeRootMotion()`, as `playAction({ rootMotion: true })` does.
- **A trigger waiting** for a combo segment's end stays raised if the swing is interrupted; reset it
  (`resetTrigger`), or it fires the next time that segment ends.

## Actions

An action is a clip played **once over whatever the machine is doing**, with no state or transition
for it in the graph — an attack, a reload, a wave. It fades in, plays, and fades out on its own.

```ts
playAction(clipName: string, options?: AnimationActionOptions): AnimationActionHandle
stopAction(slot?: string, blendOut?: number): void     // every slot when omitted
isActionPlaying(slot?: string): boolean                // any slot when omitted

interface AnimationActionOptions {
  slot?: string        // default: the machine's first declared slot, else an implicit full-body one
  blendIn?: number     // seconds, default 0.15
  blendOut?: number    // seconds, default 0.2
  speed?: number       // default 1
  loop?: boolean       // default false: loops until stopped
  ikWeight?: number    // foot-IK weight while it plays, default 1 (a roll passes 0)
  rootMotion?: boolean // extract the clip's travel for consumeRootMotion(), default false
  startTime?: number   // clip seconds to start from, default 0
}

interface AnimationActionHandle {
  readonly slot: string
  readonly clipName: string
  readonly done: boolean
  readonly finished: Promise<void>   // resolves once it has faded fully out, however it ended
  stop(blendOut?: number): void
}
```

```ts
async onAction(action: string, state: ActionState) {
  if (action === 'Reload' && state.started && !animator.isActionPlaying('UpperBody')) {
    await animator.playAction('Reload', { slot: 'UpperBody' }).finished
    this.ammo = this.magazineSize
  }
}
```

A slot is declared on the machine — name, which layer it sits above, a bone mask, override or
additive — in the editor's [Action slots](../editor/animation.md#action-slots) section. An
`UpperBody` slot with an upper-body mask is what keeps the legs on locomotion while the arms reload.

- **With no slots declared**, `playAction` plays full-body over everything, in an implicit slot
  called `FullBody`. Asking for an undeclared slot name does the same.
- **A second action in the same slot cross-fades** from the first, and the first one's `finished`
  resolves at that moment.
- **The fade-out ends with the clip**, not after it: a non-looping action starts fading `blendOut`
  seconds before its last frame.
- **An unknown clip name** logs a warning and returns a handle that is already `done`.

## Events

An event marker fires a named event at a time you scrub on the timeline. That is how a footstep
sound, a hit frame or a particle burst stays in sync with the animation rather than with a timer.

Markers come from two places, and both arrive through the same callback:

- **On the clip** (`Animation.events`, authored on the Events track of the clip player and of the
  Animator's transport). These fire wherever the clip plays — a base state, a layer or an action slot.
- **On the state machine** (`AnimationStateMachine.events`), keyed by clip name. The older form: it
  still fires, but the editor moves these onto their clips when the animator is opened, and a marker
  the clip also carries fires only once.

```ts
const stop = animator.onAnimationEvent((eventName: string, clipName: string) => {
  if (eventName === 'footstep') this.playFootstep()
})
stop()      // unsubscribe
```

`onAnimationEvent` is a method on the ANIMATOR, not a node lifecycle hook — there is no
`onAnimationEvent()` alongside `onStart`/`onUpdate`. It also has no automatic cleanup, unlike
`this.after`: keep the returned function and call it from `onDespawn`, or a node that respawns will
hold two listeners and do everything twice.

Marker times are in CLIP seconds, so a state playing at `speed: 1.5` fires the marker at
`time / 1.5` wall-clock seconds. A marker beyond a state's `exitTime` is never reached at all.
A marker AT time 0 fires when its clip starts or restarts (a one-shot retriggered every shot fires it
each time); a state that joins its clip part-way (`startTime`) fires only the markers after that.
`examples/scripts/SoulsEnemy.ts` times its attacks' hits this way.

### Event Actions: effects without a script

A marker says WHEN; the state machine says WHAT. `AnimationStateMachine.eventActions` binds an event
name to a list of actions the animator runs itself, before any `onAnimationEvent` listener hears it,
so a sound, a particle burst, a light flash or a spawned template stays in sync with the clip and
needs no code:

```ts
eventActions: [{
  event: 'shot',                 // the marker's name; optional `clip` limits it to one clip
  actions: [
    { kind: 'sound', target: 'Sounds/Shot' },                               // plays it; a new shot rings over the last
    { kind: 'particles', target: 'Muzzle/Sparks', mode: 'burst', count: 12 }, // or 'play' / 'stop'
    { kind: 'light', target: 'Muzzle/Light', intensity: 9000, seconds: 0.06 }, // flash, then off
    { kind: 'spawn', template: 'Muzzle Flash', at: 'Muzzle', rotation: 'camera' },
  ],
}]
```

- **Targets are paths** (`Sounds/Shot`), found from the animated node down and then from each
  ancestor up, nearest first, so a weapon's own sounds win over its owner's. A path nothing has logs
  one warning and the rest of the actions still run.
- **Sound** plays the node; while it is still sounding a new one plays on a spare copy (up to six),
  `overlap: false` restarts it instead.
- **Light** flashes an existing light node you author at intensity 0 (`falloff` shapes the fade).
  Between flashes it sits at no intensity and the smallest range, so it holds no cluster slot.
- **Spawn** instantiates the template at the target node (default: the animated node), moved by
  `offset` (in the target's frame) and turned to the target, the animated node (`owner`: a character's
  facing), the active `camera`, or fixed Euler degrees; `follow: true` keeps it on the target for as long as it lives, so recoil and the weapon's
  clips carry it. A target inside a viewmodel is placed where it is DRAWN, through the camera's
  viewmodel lens.
- **Scripts can fire the same event** for things with no clip: `animator.fireEvent('shot')` runs the
  bindings and tells listeners, so a bot's shot is still the controller's data, not code.

The bindings live on the machine, so they travel with the controller asset and the node, and a
weapon and a character can bind the same marker name to different effects. Edit them in the Animator
editor's Event Actions panel.

## Blend spaces

A blend space blends several clips by where a probe sits on a 1D or 2D plot. In code it is an
`AnimationField`. Normally a *state* plays one and the animator drives its axes. To drive one directly:

```ts
playBlendSpace(field: AnimationField, x: number, y?: number, loop = true): void   // = playField
playField(field: AnimationField, x: number, y?: number, loop = true): void
updateField(field: AnimationField): void
setFieldProbe(x: number, y?: number): void
get isPlayingField: boolean
get activeFieldWeights
get fieldDebug
```

```ts
interface AnimationField {
  mode: '1d' | '2d'
  xAxis: AnimationFieldAxis
  yAxis?: AnimationFieldAxis
  samples: AnimationFieldSample[]
  weightSmoothing?: number
}
interface AnimationFieldAxis { name; min; max; smoothing?; deadzone?; wrap? }
interface AnimationFieldSample { clipName; x; y?; rateScale?; phaseOffset?; pose?; poseRef? }
```

Defaults: `DEFAULT_AXIS_SMOOTHING = 0.08`, `DEFAULT_WEIGHT_SMOOTHING = 0.06`.

**Pose samples.** A sample can hold a pose: its `clipName` is then its key, `poseSampleKey(poseId)` (`pose:<id>`),
and its pose is the field's `poses[key]` (or the sample's own `pose`). A pose is held: `rateScale` and `phaseOffset`
do not apply, and the clips alone set the cycle (a field of poses only lasts a second). The same key at many points
is one pose. In `poses`, a variant names its base's key (`base`) and stores only what it changes from it; the
runtime composes it, and on an additive layer adds what it changes from the base.

> ### Two valid layouts, and do not mix them
>
> - `forwardSpeed × lateralSpeed` — both **signed**, neither wrapping.
> - `planarAngle × planarSpeed` — a **wrapping** direction axis against an unsigned magnitude.
>
> Mixing them puts samples where the probe can never reach: an unsigned axis clamps at 0, so a
> sample at a negative coordinate on it is simply unreachable and its clip never plays.
>
> **Turn on `wrap` for a heading axis.** It makes the axis a circle, so `−180` and `+180` are the
> same heading and a probe at `−170` is ten degrees from the backward clips rather than 350.

> **Do not also give a field state a playback speed.** A field matches speed by *choosing clips*,
> not by playing one faster. Binding movement speed to both the field's axis and the state's
> playback rate multiplies it twice — the run plays 4× too fast and idle freezes.

If two clips at a diagonal look like the legs are fighting rather than blending, they start at
different points in the gait. Set `phaseOffset` to `0.5` on one of them.

## Foot IK

An analytic two-bone solver that plants feet on uneven ground. The rig lives on the model's `Skin`
and is authored in the editor's skeleton tree; per-state weight comes from `AnimationState.ikWeight`
or a parameter.

```ts
interface IkFootChain { thigh: number; shin: number; foot: number; toe?: number }
interface IkRig { hips?: number; feet: IkFootChain[] }     // node indices into Skin.joints
```

`IK_DEFAULTS`: `footHeight 0.1`, `traceUp 0.5`, `traceDown 0.6`, `swingRelease 0.2`,
`maxHipDrop 0.5`, `maxSlopeDeg 45`, `smoothing 0.12`, and foot locking: `footLock 0` (off),
`lockSpeed 0.5`, `lockHeight 0.03`, `lockRelease 0.15`, `lockDistance 0.35`, `lockBlendIn 0`,
`lockBlendCurve 'linear'`, `lockCatchSpeed 0`.

**Foot locking** (`footLock` above 0) keeps a foot the animation has planted on its spot and heading in
the world while the body moves or turns over it, which is what stops a character gliding when it turns
while it walks. A foot plants when it is down (ankle on its ground, ball within `lockHeight` of the
lowest foot) and the animation holds it still: rising or sinking slower than `lockSpeed`, and crossing
the ground (the body's own turning left out) slower than `lockSpeed` plus 1.5 times the body's speed.
The ball of the foot is held, through heel-off, and its heading up to `FOOT_LOCK_MAX_TWIST` (40 degrees).
It lets go over `lockRelease` seconds when the animation lifts it, or when it is left more than
`lockDistance` from where the animation has it, and at once when the body jumps further than that in one
frame (a teleport). A state with no foot placement has no locking either, nor one whose
`AnimationState.footLock` is `false`.

A held foot may pull its leg straight; one being let go never pulls it past 97% of its length (or past the clip's
own stretch), by how far it has been let go. `lockCatchSpeed` (m/s, 0 off) keeps a lock from catching a foot that
slides faster than that while the pose still blends in a clip with no windows (a cross-fade out of Idle): caught,
it stops dead and the leg is left stretched after it. The knee is solved toward the clip's own bend, turning to
`forward` smoothly as that bend shrinks or points behind: a hard switch flipped a strafe's knee, which swings out
past sideways.

**Blending a lock.** `lockBlendIn` (seconds) eases a planting foot into its lock: the point it is held at is where
the foot was shown as it planted, and the lock's weight rises from 0 over `lockBlendIn`, so a foot that plants
mid-slide slows to a stop instead of stopping dead. `lockRelease` is the way out. `lockBlendCurve` shapes both:
`'linear'`, or `'smooth'` (eased in and out, `footLockWeight(alpha, 'smooth')` is smoothstep). A foot that plants
again while it is still being let go keeps its point and rises from where it is. With `lockBlendIn` 0 a lock is
on the frame the foot plants, as before.

**Foot-lock windows.** A clip may say when each foot is planted, instead of leaving it to the detection above:

```ts
interface Animation { footLocks?: Record<string, [number, number][]> }   // per foot, spans in clip seconds
```

- **Keys.** A foot's key is its humanoid slot (`footLockKey('mixamorig:LeftFoot')` is `'foot.L'`), or the bone name
  on a rig that is not humanoid.
- **Inside a span** the foot plants and is held. When the span ends it lets go over `lockRelease`, even with the
  foot still down.
- **Missing vs empty.** An empty list never locks that foot; a foot with no entry is detected as above.
- **Blends.** Weighted as the pose is: a blend space's samples each at their own time, a cross-fade's two sides by
  the blend. A foot whose posed clips have no windows for it, over half their weight, is detected.
- **Planted at any height** (`AnimationState.plantInWindows`). Foot placement lets go of a foot the clip lifts more
  than `swingRelease` over the lowest one, reading it as a swing. In a state with `plantInWindows: true`, a foot
  inside its window keeps its ground correction however high the clip holds it. The share of the pose inside a
  window decides, damped over the rig's `smoothing`. For a stair climb, whose upper foot stands a riser above the
  lower one and would otherwise float over its tread. Off by default; base layer only.

Helpers in `footLockWindows.ts`:
- `detectFootLockWindows(clip, skin, { heelLift, ground })`: spans from the ball coming down to the heel lifting
  `heelLift` (3 cm). `ground: 'stance'` judges "down" against each stance's own height (a stretch of at least
  0.1 s over which the ball holds its height) instead of the clip's lowest, for a clip whose feet plant at different
  heights: a stair climb with its rise kept;
- `shrinkFootLockSpans(windows, keep)`: each span cut to its middle `keep` share (0 to 1), spans left shorter
  than 0.06 s dropped, for clips whose feet should lock for less of each stance;
- `footLockAt(clip, key, time)`;
- `normalizeFootLockSpans(spans, duration)`;
- `humanoidFeet(skin)`.

Functions: `solveTwoBone`, `applyTwoBone`, `ikTuning`, `validateIkRig`, `swingReleaseWeight`,
`stepFootLock`, `footLockWeight`; `FOOT_LOCK_CURVES` lists the curves.

## Root motion

Root motion lets a clip physically move the character — the body if it has one, otherwise the model
node — instead of snapping back to where it started. Enable it per clip in the editor.

Use it on turn-in-place and other clips whose *animation* is authoritative. Leave it **off** on
locomotion clips driven by physics velocity, or the character double-moves. A field state ignores
root motion entirely, and so does everything above the base layer: a layer or an action never moves
the character. Either can EXTRACT its clip's ground travel instead — a layer state with
`extractRootMotion`, an action with `rootMotion: true` — for a script to read with
`consumeRootMotion()` and move the body by, through its own collision.

On a [Character](characters-and-controllers.md), root motion ADDS to the character's own movement. A state
whose clip should be the only thing moving it (a hard landing, a stagger) sets `holdMovement`
([Holding the character still](#driving-a-state-machine)).

A clip that both travels and turns (getting into a car: a step in, a quarter turn to face ahead) carries the
character along the path the clip takes: each frame's travel goes the way the clip faces at that moment, so a turn
and then a step moves it where the clip's step goes. The root's travel is in the clip's own frame, as the clip was
authored. With a body switched off (`physicsEnabled`, [Motion and physics](motion-and-physics.md#turning-a-body-off-for-a-while)),
root motion moves its node directly.

## Ragdolls

```ts
animator.enableRagdoll(bodies: Map<number, RagdollBodyRef>): void
animator.disableRagdoll(): void
get ragdollActive: boolean
```

In practice you start one through physics, which wires the animator for you:

```ts
this.scene.physics.startRagdoll(modelNode, { impulse: [0, 1.5, -2] })
```

This is the usual substitute for a death animation.

## Sockets

A socket is a named attach point on a bone, authored on the rig
([Sockets](../editor/animation.md#sockets)). To hold something in a hand, attach the item **node** to
it — the scene then moves the node onto the socket every frame:

```ts
const sword = this.findNode('Sword')!
sword.attachToSocket('parent', 'RightHand')    // nearest character above the sword
sword.attachToSocket(this, 'RightHand')        // or a specific character node
sword.detachFromSocket()                       // drops it where it is
```

See [Node API](node-api.md#sockets) for the attachment itself. To *read* where a socket is — to aim a
ray from a muzzle, say — ask the skinned model:

```ts
get socketNames: string[]                               // ModelNode
getSocketWorldMatrix(name: string, out?: mat4): mat4 | null
```

```ts
const model = this.findNode('Ch36') as ModelNode
const m = model.getSocketWorldMatrix('RightHand')
if (m) {
  const muzzle = Vec.mat4.getTranslation(Vec.vec3.create(), m)
}
```

`getSocketWorldMatrix` returns `null` when the model has no such socket. The socket ignores its bone's
scale, so an FBX armature's `0.01` does not shrink what it holds; scale comes from the socket's own
offset.

Followers are moved in the scene's late pass — after every animator has posed, before camera rigs —
so a held item never trails the hand by a frame.

## Bone matrices

```ts
getFinalBoneMatrices(): mat4[]
getFinalBoneMatricesFlat(): number[]
getJointModelMatrix(jointIndex: number): mat4 | null    // a joint relative to the model node
```

For drawing your own overlay, or for a bone that has no socket. `getJointModelMatrix` is in
**model** space — multiply by the model node's `worldTransform` for a world matrix — and is indexed
like `Skin.joints`. It is a live matrix, overwritten by the next pose: clone it to keep it.

## Retargeting

Clips are stored in their **source rig's** space and retargeted when used, so one clip asset plays
on several different skeletons. Import-time mapping is a UI flow
([guide](../editor/models-and-materials.md#animation-import-and-retargeting)); the functions behind
it are exported if you need them: `buildBoneMapping`, `applyManualMapping`, `mappingReport`,
`retargetAnimation`, `remapAnimationToSkin`, `describeRetarget`, `humanoidRigOf`,
`normalizeBoneName`, `humanoidSlotOf`.

## See also

[Animation (editor)](../editor/animation.md) · [Animation built-ins](../reference/animation-builtins.md) · [Characters and controllers](characters-and-controllers.md)
