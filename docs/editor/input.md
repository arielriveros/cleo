# Input

**Options ▸ Project ▸ Input** authors the project's action map: what verbs the game has, and what
drives them. It sits over a live scene, so you can judge a change immediately. See [Options](options.md).

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

## Action maps

Actions are grouped into maps, and a map is a context: turn one off and everything held in it is
released. Enabling and disabling maps is how you switch context — the default project has
**Gameplay** and **UI**, and a pause menu turns one off and the other on. A map's toggle in the list
is whether it starts enabled; a script turns maps on and off at runtime:

```ts
Input.enableMap('UI')
Input.disableMap('Gameplay')
```

Actions can be addressed bare (`'Jump'`) or qualified (`'Gameplay/Jump'`). Qualify when two maps
define the same name.

## Actions

The selected map's verbs. Each has a name, which is what scripts and controllers read, and a
**kind**:

| Kind | Reads as |
|---|---|
| **Button** | On/off, or `0..1` for an analog trigger. |
| **Axis** | `-1..1`. |
| **Vector** | A 2D pair, Y positive up. |

A button action also has a **Press point**, how far an analog trigger must be pulled to count as
pressed (a key is always 1), and a **Hold time**, the seconds it must be held before its phase
becomes `performed` (0 = immediately).

## Bindings

The selected action's bindings: what drives it. Pick a source from the dropdowns, or press
**Listen** and then the key, button, stick or gesture you want (Escape cancels). Listening is how
anyone actually rebinds a key; the dropdowns are the only way to reach a source you cannot press
right now — a gamepad button with no pad plugged in, a touch gesture on a desktop, or Escape itself.
**⋯** opens a binding's modifiers and processors.

Sources come from seven device kinds: *Keyboard*, *Mouse button*, *Mouse axis*, *Gamepad button*,
*Gamepad axis*, *Touch gesture* and *On-screen control*. Keys are **physical**: `KeyW` is the same
key whether it prints `w` or `z`. Left and right modifiers are distinct, so "either Shift" is two
bindings. A gamepad source can be fixed to one local player (*P1*, *P2*, …) or left on *Any pad*,
which follows whichever pad is pushing hardest — right for one player.

A source bound somewhere else too is reported under the binding (*Also bound in …*), never blocked:
Escape is both Cancel and Pause in the default map on purpose, and a shared key under different
modifiers is normal. You are the one who can tell those from a mistake.

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

**Only while held** — a binding's gates, under its **⋯**: the left Ctrl, Shift, Alt and Meta keys,
the mouse buttons, and two states: the pointer locked, and the pointer over the game. All of them
must be held. A plain binding on
the same input stands down while a modified one is active, so Ctrl+S does not also fire S.

### Processors

Shaping steps applied in order, per binding and then per action. Order is meaning: a deadzone after
a scale is not the same patch as one before it, so the arrows reorder for real.

| Processor | Use |
|---|---|
| **Deadzone (per axis)** | Ignore small values, saturate near the end. |
| **Deadzone (radial)** | The same on a 2D magnitude — **the correct one for a stick**. |
| **Scale** | Multiply. Negative inverts. |
| **Invert** | Negate. |
| **Curve** | A response exponent. |
| **Smooth** | Damp toward the raw value. |
| **Normalize** | Clamp a vector to unit length **without** amplifying a short one. |

`normalize` on `Move` is what clamps the keyboard diagonal without turning a half-pushed stick into
a full one.

**Action processors** — the action's own chain, under its bindings: applied after the winning
binding, to the composed value.

## Live values

A live read-out of the selected map's actions: each one's current value, phase and driving device.
Press keys, move a stick or drag on a touch screen, and it updates as you do. This answers, in order,
the three questions that come up:

1. Is the action firing at all?
2. Is it the right magnitude?
3. Which device is driving it?

An action that does nothing in game and nothing in the monitor is a **binding** problem. One that
moves in the monitor and does nothing in game is a **script or controller** problem — usually an
action name typo, since an unknown name reads idle rather than throwing.

## On-screen controls

Virtual sticks and buttons drawn over the game on a touch device, and bindable like any other
source (device *On-screen control*). Drag them onto a 16:9 preview drawn with the same layout maths
the runtime uses. Two ship by default: a `moveStick` and a `jump` button. Their coordinates are
fractions of the screen, so the layout holds at any resolution.

They appear only when the device reports a touch screen — there is no separate enable switch.

Bindings name a control by its id, so one action can be driven by a key, a stick and an on-screen
control at once.

## Reset

**Restore default bindings** replaces every map with the ones this build ships — the default map
in [Input bindings](../reference/input-bindings.md). It asks first.

## Wiring actions to a character

A Controller names actions rather than keys: **Move**, **Look**, **Jump**, **Sprint**, **Crouch**.
Change which action drives what on the [controller](ai-agents.md#actions-player-source); change what
drives the action here.

That two-level indirection is the point: the same two scripts run on every device, and a player can
rebind any of it without touching either.

## The editor's own camera controls

The editor's viewport navigation uses its own map, which is deliberately not user-editable — and
not shown here — so a project that rebinds everything cannot make the editor unusable.

## Robustness

The map reader is deliberately tolerant: unknown processor kinds, device arms and gestures are
dropped rather than throwing, and a map that fails to parse entirely falls back to the **default
map** rather than to nothing. A project with a corrupt input map still has working controls.

## See also

[Input bindings](../reference/input-bindings.md) · [Input (scripting)](../scripting/input.md) · [AI agents](ai-agents.md) · [UI](ui.md)
