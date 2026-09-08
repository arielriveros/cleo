# Input

Scripts read **actions** — named verbs like `Jump` and `Move` — never key codes. What drives an
action is authored in the editor's Input panel and can be rebound by the player, so the same script
runs on a keyboard, a gamepad and a touch screen without changing.

The bindings themselves are documented in [Input bindings](../reference/input-bindings.md); how to
author them is in [Input (editor)](../editor/input.md).

## The facade

```ts
import { Input } from 'cleo'

Input.vector(action: string): [number, number]   // Y positive UP
Input.value(action: string): number              // -1..1 for an axis, 0..1 for an analog button
Input.pressed(action: string): boolean           // true every frame it is held
Input.started(action: string): boolean           // true only on the frame the press began
Input.released(action: string): boolean
Input.heldSeconds(action: string): number
Input.phase(action: string): 'idle' | 'started' | 'performed' | 'canceled'
Input.state(action: string): Readonly<ActionState>
Input.device(action: string): DeviceKind | null  // what last drove it
```

An unknown action name reads idle rather than throwing, so a typo is a silent no-op — check the
Input panel's monitor if something does nothing.

Actions can be addressed bare (`'Jump'`) or qualified with their map (`'Gameplay/Jump'`). Qualify
when two maps define the same name.

```ts
onUpdate(delta: number) {
  const move = Input.vector('Move')            // already composed and normalized
  const sprint = Input.pressed('Sprint')

  if (Input.started('Jump') && this.isGrounded) this.jump()
}
```

`Move` arrives **analog**: a half-pushed stick walks at half speed, while a key is always full.

## Push instead of poll

```ts
onAction(action: string, state: ActionState) {
  if (action === 'Interact' && state.started) this.interact()
}
```

`onAction` fires just before that frame's `onUpdate`, only on nodes that actually override it, and
there is nothing to unregister when the node despawns.

```ts
interface ActionState {
  kind: ActionKind          // 'button' | 'axis' | 'vector'
  value: number
  vector: [number, number]
  pressed: boolean
  started: boolean
  released: boolean
  phase: ActionPhase
  heldSeconds: number
  device: DeviceKind | null
}
```

For a global listener that is not tied to a node:

```ts
const stop = Input.onAction('Pause', state => { if (state.started) Game.togglePause() })
// '*' matches every action
stop()      // unsubscribe
```

> ### A controller must poll, not use `onAction`
>
> `onAction` is dispatched inside the node loop, which runs **after** the control pass. A
> `ControllerNode` deciding what to do this frame has to read `Input.started(…)` directly; an
> `onAction` handler would act one frame late. This is why the built-in controller polls.

## Maps

Actions are grouped into maps (`Gameplay`, `UI`, and any you add). Enabling and disabling maps is
how you switch context:

```ts
Input.enableMap('UI')
Input.disableMap('Gameplay')      // the player stops steering while the menu is up
Input.isMapEnabled('Gameplay')
Input.enabledMaps                 // readonly
```

## Mouse capture

```ts
Input.captureMouse()
Input.releaseMouse()
Input.isMouseCaptured
```

Pointer lock has to be requested from a user gesture, so `captureMouse` is something you call from
a click handler or a button press, not from `onStart`.

The default `Look` binding already handles both cases: mouse movement drives it when the pointer is
locked **or** while the left button is held, and never when the cursor is merely passing over the
page.

## The authored map

```ts
Input.map        // the InputMap, read-only at runtime
```

Useful for building a rebinding screen: read the map to show what is currently bound, then use the
system's rebind capture to change it.

```ts
InputSystem.beginRebind(filter?): Promise<BindingSource | null>
InputSystem.cancelRebind(): void
InputSystem.get isRebinding: boolean
```

`beginRebind` resolves with the next input the player produces, so a "press any key" prompt is:

```ts
async rebindJump() {
  const source = await InputSystem.beginRebind()
  if (source) { /* write it into your copy of the map */ }
}
```

## Other `InputSystem` members

You rarely need these — `Input` is the intended surface — but they exist:

```ts
InputSystem.isKeyDown(code: string): boolean      // raw, bypasses the action system
InputSystem.get changedThisFrame: readonly ActionChange[]
InputSystem.setMap(raw: unknown): void
InputSystem.setOverlayMaps(maps): void
InputSystem.layoutVirtualControls(w: number, h: number): void
InputSystem.virtualReading(id: string)
InputSystem.get hasSeenGamepad: boolean
InputSystem.pointerLockOnClick: boolean
InputSystem.preventDefault: boolean
InputSystem.resetState(): void
```

`isKeyDown` is an escape hatch for debug shortcuts. Anything a player will use should be an action.

## See also

[Input bindings](../reference/input-bindings.md) · [Input (editor)](../editor/input.md) · [Characters and controllers](characters-and-controllers.md)
