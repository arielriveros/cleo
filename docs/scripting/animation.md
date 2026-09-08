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
continuously, use a state machine: it handles blending, exit times and hysteresis for you.

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

## Events

An event marker on a clip fires a named event at a time you scrub on the timeline. That is how a
footstep sound, a hit frame or a particle burst stays in sync with the animation rather than with a
timer.

```ts
const stop = animator.onAnimationEvent((eventName: string, clipName: string) => {
  if (eventName === 'footstep') this.playFootstep()
})
stop()      // unsubscribe
```

Nodes can also receive events through an `onAnimationEvent` handler.

## Blend spaces

A field blends several clips by where a probe sits on a 1D or 2D plot. Normally a *state* plays a
field and the machine drives its axes. To drive one directly:

```ts
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
root motion entirely.

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

## Bone matrices

```ts
getFinalBoneMatrices(): mat4[]
getFinalBoneMatricesFlat(): number[]
```

For attaching things to bones, or drawing your own overlay.

## Retargeting

Clips are stored in their **source rig's** space and retargeted when used, so one clip asset plays
on several different skeletons. Import-time mapping is a UI flow
([guide](../editor/models-and-materials.md#animation-import-and-retargeting)); the functions behind
it are exported if you need them: `buildBoneMapping`, `applyManualMapping`, `mappingReport`,
`retargetAnimation`, `remapAnimationToSkin`, `describeRetarget`, `humanoidRigOf`,
`normalizeBoneName`, `humanoidSlotOf`.

## See also

[Animation (editor)](../editor/animation.md) · [Animation built-ins](../reference/animation-builtins.md) · [Characters and controllers](characters-and-controllers.md)
