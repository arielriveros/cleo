# Reference — input bindings

The vocabulary the input system binds against, and the map that ships by default. How to author
bindings is in [Input (editor)](../editor/input.md); how to read them is in
[Input (scripting)](../scripting/input.md).

---

## Actions

An **action** is a named verb (`'Jump'`, `'Move'`). Scripts read actions, never keys, which is what
lets the same code run on keyboard, gamepad and touch and lets players rebind anything.

```ts
type ActionKind  = 'button' | 'axis' | 'vector'
type ActionPhase = 'idle' | 'started' | 'performed' | 'canceled'
```

| Kind | Reads as | Read it with |
|---|---|---|
| `button` | on/off, `0..1` for an analog trigger | `Input.pressed` / `started` / `released` |
| `axis` | `-1..1` | `Input.value` |
| `vector` | a 2D pair, **Y positive up** | `Input.vector` |

`DEFAULT_PRESS_POINT = 0.5` — the threshold at which an analog input counts as pressed. Without it
a trigger could not act as a button at all.

## Devices

```ts
type DeviceKind = 'key' | 'mouse' | 'pointer' | 'gamepad' | 'gamepadAxis' | 'touch' | 'virtual'
```

### Keys — `KEY_CODES`

A binding names a `KeyboardEvent.code`, i.e. a **physical key**: `KeyW` is the same key whether it
prints `w` or `z`. Left and right modifiers are distinct codes — "either Shift" needs two bindings.

| Group | Codes |
|---|---|
| Letters | `KeyA` … `KeyZ` |
| Digit row | `Digit0` … `Digit9` |
| Editing / whitespace | `Escape`, `Tab`, `CapsLock`, `Enter`, `Backspace`, `Space` |
| Modifiers | `ShiftLeft`, `ShiftRight`, `ControlLeft`, `ControlRight`, `AltLeft`, `AltRight`, `MetaLeft`, `MetaRight`, `ContextMenu` |
| Arrows / navigation | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Insert`, `Delete`, `Home`, `End`, `PageUp`, `PageDown` |
| Function row | `F1` … `F12` |
| Numpad | `Numpad0` … `Numpad9`, `NumpadAdd`, `NumpadSubtract`, `NumpadMultiply`, `NumpadDivide`, `NumpadDecimal`, `NumpadEnter`, `NumLock` |
| Punctuation (US-layout names for the **key**, not the printed glyph) | `Minus`, `Equal`, `BracketLeft`, `BracketRight`, `Backslash`, `Semicolon`, `Quote`, `Backquote`, `Comma`, `Period`, `Slash`, `IntlBackslash` |

> This list is what the editor's picker offers, not a limit. The type is
> `typeof KEY_CODES[number] | (string & {})`, so a code this build has never heard of still binds.

### Mouse — `MOUSE_BUTTONS`

`'left'`, `'middle'`, `'right'`, `'back'`, `'forward'`.

### Pointer — `POINTER_AXES`

| Axis | Meaning |
|---|---|
| `deltaX`, `deltaY` | Movement during the frame. Relative movement under pointer lock, where there is no cursor. |
| `wheelX`, `wheelY` | Scroll accumulated during the frame. |
| `x`, `y` | Absolute position in the canvas, **normalized 0..1**, so a binding does not depend on viewport pixel size. |

### Gamepad — `GAMEPAD_BUTTONS`, `GAMEPAD_AXES`

Buttons, in W3C standard-mapping index order (the index of a name here *is* its `gamepad.buttons`
index): `a`, `b`, `x`, `y`, `leftBumper`, `rightBumper`, `leftTrigger`, `rightTrigger`, `select`,
`start`, `leftStick`, `rightStick`, `dpadUp`, `dpadDown`, `dpadLeft`, `dpadRight`, `home`.

Axes: `leftStickX`, `leftStickY`, `rightStickX`, `rightStickY`.

`MAX_GAMEPAD_PLAYERS = 4`. Slots are stable across disconnects, so player 2 unplugging does not
promote player 3.

> A pad reporting `mapping !== 'standard'` gives no guarantee these names mean anything.

### Touch — `TOUCH_GESTURES`

`tap`, `doubleTap`, `longPress` are one-shot buttons. `drag` produces a per-frame movement pair;
`pinch` a per-frame scale delta.

### Virtual

On-screen controls authored in the Input panel, addressed by id. They are drawn only when the
device reports a touch screen.

## State gates — `STATE_FLAGS`

`'pointerLock'`, `'pointerOverCanvas'`. A binding can be gated on a held state. Only sources with
an unambiguous on/off reading may gate — an axis cannot, because "is the stick held?" has no answer
everyone would agree with.

## Composites — `COMPOSITE_PARTS`

`positive`, `negative`, `up`, `down`, `left`, `right`, `x`, `y`. Which slot of a composite a
binding drives. Absent means it drives the whole value — a stick bound to a `vector` action with no
part contributes both components at once.

## Processors — `PROCESSOR_KINDS`

Shaping steps applied in order, per binding and then per action.

| Kind | Parameters | Effect |
|---|---|---|
| `deadzone` | `min`, `max` | Ignore below `min`, saturate at `max`, rescale between. |
| `radialDeadzone` | `min`, `max` | The same, on a 2D magnitude — the correct one for a stick. |
| `scale` | `factor` | Multiply. A negative factor inverts. |
| `invert` | — | Negate. |
| `curve` | `exponent` | Apply a response curve, preserving sign. |
| `smooth` | rate | Damp toward the raw value over time. |
| `normalize` | — | Clamp a vector to unit length **without** amplifying a short one. |

---

## The default map

Two maps ship enabled, plus two virtual controls.

### Gameplay

| Action | Kind | Bound to |
|---|---|---|
| `Move` | vector | `W`/`A`/`S`/`D` and the arrow keys as composite parts; left stick X/Y with a `0.15–0.95` deadzone; the `moveStick` virtual control. Action-level `normalize`, which clamps the keyboard diagonal without amplifying a half-pushed stick. |
| `Look` | vector | Pointer `deltaX`/`deltaY` gated on **pointer lock**, *and again* gated on **left mouse held**; right stick X/Y with a stick deadzone and `scale 4` (Y is `-4`); touch `drag`. |
| `Jump` | button | `Space`, pad `a`, the `jump` virtual control. |
| `Sprint` | button | `ShiftLeft`, pad `leftStick` (L3). |
| `Fire` | button | Left mouse, pad `rightTrigger`, touch `tap`. |
| `Zoom` | axis | Pointer `wheelY`, touch `pinch`. |

`Look` is the one worth reading closely: the two-way pointer gating is the binding-level expression
of the guard every camera script used to open with — mouse-look works when the pointer is locked
*or* while you drag with the left button, and never when you are just moving the cursor over the
page.

### UI

| Action | Kind | Bound to |
|---|---|---|
| `Navigate` | vector | Arrow keys as composite parts; left stick with a wider `0.5–0.95` deadzone (a menu wants discrete steps, not analog drift). |
| `Submit` | button | `Enter`, pad `a`. |
| `Cancel` | button | `Escape`, pad `b`. |
| `Pause` | button | `Escape`, pad `start`. |

### Virtual controls

| Id | Kind | Placement |
|---|---|---|
| `moveStick` | stick | `x 0.15`, `y 0.76`, `radius 0.11`, `deadzone 0.12` |
| `jump` | button | `x 0.87`, `y 0.78`, `radius 0.07`, label `Jump` |

Coordinates are fractions of the screen, so the layout holds at any resolution.

### Touch gesture config — `DEFAULT_TOUCH_CONFIG`

`tapMaxSeconds: 0.25`, `tapMaxPixels: 12`, plus the double-tap and long-press windows.

---

## Reading a map that came from a newer build

`parseInputMap` is deliberately tolerant: unknown processor kinds, device arms and gestures are
dropped rather than thrown, and a blob with **no readable maps at all** falls back to
`DEFAULT_INPUT_MAP` rather than to an empty map — a project that fails to parse still has working
controls instead of a game that cannot be played.

## See also

[Input (editor)](../editor/input.md) · [Input (scripting)](../scripting/input.md) · [API index](api-index.md)
