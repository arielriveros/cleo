# Input

**Input mode** authors the project's action map: what verbs the game has, and what drives them. It
shows only the Input panel over a live scene, so you can judge a change immediately.

The vocabulary and the default map are in [Input bindings](../reference/input-bindings.md); reading
actions from script is in [Input (scripting)](../scripting/input.md).

## The model

```
Map (Gameplay, UI, …)
└── Action (Move, Jump, …)          a named verb, with a kind
    └── Binding (KeyW, leftStickX, …)   what drives it
        ├── part        which slot of a composite it feeds
        ├── modifiers   held states that gate it
        └── processors  shaping applied to its value
```

Scripts read **actions**, never keys. That is what lets one script run on keyboard, gamepad and
touch, and lets a player rebind anything.

There is no separate apply step — edits take effect immediately.

## Actions

An action has a **kind**:

| Kind | Reads as |
|---|---|
| **Button** | On/off, or `0..1` for an analog trigger. |
| **Axis** | `-1..1`. |
| **Vector** | A 2D pair, Y positive up. |

## Bindings

Add a binding and pick its source, or use **press-to-rebind**: click, then press the key, button,
stick or gesture you want.

Sources come from seven device kinds — key, mouse, pointer, gamepad, gamepad axis, touch, virtual.
Keys are **physical**: `KeyW` is the same key whether it prints `w` or `z`. Left and right modifiers
are distinct, so "either Shift" is two bindings.

### Composites

A vector action is usually built from several bindings, each feeding one **part**: `W` → up, `S` →
down, `A` → left, `D` → right. A stick with no part set contributes both components at once.

### Modifiers

A binding can be gated on a held state or another input. The default `Look` action does this twice
over: pointer movement drives it while the pointer is **locked**, *and* separately while the **left
button** is held. That is the binding-level expression of the guard every camera script used to open
with — and it means mouse-look works both ways with no script involved.

Only sources with an unambiguous on/off reading may gate. An axis cannot, because "is the stick
held?" has no answer everyone agrees with.

### Processors

Shaping steps applied in order, per binding and then per action:

| Processor | Use |
|---|---|
| **Deadzone** | Ignore small values, saturate near the end. |
| **Radial deadzone** | The same on a 2D magnitude — **the correct one for a stick**. |
| **Scale** | Multiply. Negative inverts. |
| **Invert** | Negate. |
| **Curve** | A response exponent. |
| **Smooth** | Damp toward the raw value. |
| **Normalize** | Clamp a vector to unit length **without** amplifying a short one. |

`normalize` on `Move` is what clamps the keyboard diagonal without turning a half-pushed stick into
a full one.

## The monitor

A live read-out of every action's current value, phase and driving device. This answers, in order,
the three questions that come up:

1. Is the action firing at all?
2. Is it the right magnitude?
3. Which device is driving it?

An action that does nothing in game and nothing in the monitor is a **binding** problem. One that
moves in the monitor and does nothing in game is a **script or controller** problem — usually an
action name typo, since an unknown name reads idle rather than throwing.

## Virtual controls

On-screen touch controls, dragged onto a 16:9 preview drawn with the same layout maths the runtime
uses. Two ship by default: a `moveStick` and a `jump` button. Their coordinates are fractions of the
screen, so the layout holds at any resolution.

They appear only when the device reports a touch screen — there is no separate enable switch.

Bind them like any other source, and one action can be driven by a key, a stick and a virtual
control at once.

## Maps and context

Actions are grouped into maps. Enabling and disabling maps is how you switch context — the default
project has **Gameplay** and **UI**, and a pause menu turns one off and the other on:

```ts
Input.enableMap('UI')
Input.disableMap('Gameplay')
```

Actions can be addressed bare (`'Jump'`) or qualified (`'Gameplay/Jump'`). Qualify when two maps
define the same name.

## Wiring actions to a character

A Controller names actions rather than keys: **Move**, **Look**, **Jump**, **Sprint**, **Crouch**.
Change which action drives what on the [controller](ai-agents.md#actions-player-source); change what
drives the action here.

That two-level indirection is the point: the same two scripts run on every device, and a player can
rebind any of it without touching either.

## The editor's own camera controls

The editor's viewport navigation uses its own map, which is deliberately not user-editable — so a
project that rebinds everything cannot make the editor unusable.

## Robustness

The map reader is deliberately tolerant: unknown processor kinds, device arms and gestures are
dropped rather than throwing, and a map that fails to parse entirely falls back to the **default
map** rather than to nothing. A project with a corrupt input map still has working controls.

## See also

[Input bindings](../reference/input-bindings.md) · [Input (scripting)](../scripting/input.md) · [AI agents](ai-agents.md) · [UI](ui.md)
