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
setTrigger(name: string): void
resetTrigger(name: string): void
getParam(name: string): number | boolean | undefined

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

A `trigger` parameter is consumed by the first transition that reads it, so it cannot fire twice.
That holds across [layers](#layers) too: they share the parameter table, and whichever layer fires on
a trigger first consumes it.

A character running a [shared animator](../editor/animation.md#shared-animators) holds a resolved
copy of it, so all of the above works the same either way. `getStateMachine()` returns that copy; its
`controllerId` says which shared animator it came from.

## Layers

A machine's layers above the base each run their own states over the shared parameters. They are
authored in the editor ([Layers and bone masks](../editor/animation.md#layers-and-bone-masks)); a
script mostly just reads them, or fades one in and out:

```ts
setLayerWeight(layer: string, weight: number): void   // 0..1
layerStateName(layer: string): string | null          // the base layer's is currentStateName
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

- **On the clip** (`Animation.events`, authored on the clip editor's timeline). These fire wherever
  the clip plays — a base state, a layer or an action slot.
- **On the state machine** (`AnimationStateMachine.events`, the Variables panel), keyed by clip name.
  The older form; it still works.

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
`examples/scripts/SoulsEnemy.ts` times its attacks' hits this way.

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
interface AnimationFieldSample { clipName; x; y?; rateScale?; phaseOffset? }
```

Defaults: `DEFAULT_AXIS_SMOOTHING = 0.08`, `DEFAULT_WEIGHT_SMOOTHING = 0.06`.

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
`maxHipDrop 0.5`, `maxSlopeDeg 45`, `smoothing 0.12`.

Functions: `solveTwoBone`, `applyTwoBone`, `ikTuning`, `validateIkRig`, `swingReleaseWeight`.

## Root motion

Root motion lets a clip physically move the character — the body if it has one, otherwise the model
node — instead of snapping back to where it started. Enable it per clip in the editor.

Use it on turn-in-place and other clips whose *animation* is authoritative. Leave it **off** on
locomotion clips driven by physics velocity, or the character double-moves. A field state ignores
root motion entirely, and so does everything above the base layer: a layer or an action never moves
the character.

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
