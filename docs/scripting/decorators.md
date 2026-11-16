# Decorators

Decorators say what a field or method of a script *means*, in one line above it: find this node for me,
call this method on that input, keep this value in saves. They are imported from `cleo` like anything
else, and the editors check them: a misspelt action or a `@child` on a number field is a type error.

```ts
import { CharacterNode, Node, child, find, onAction, save } from 'cleo'

export default class TurretNode extends Node {
  @child('Muzzle') private _muzzle?: Node             // the Muzzle under this node
  @find('GameManager') private _gm: Node | null = null // the GameManager anywhere in the scene
  @save kills = 0                                      // kept by saves

  @onAction('Fire') fire() { /* … */ }                 // when the Fire action is pressed
}
```

Decorators go on a class's **fields and methods** — not on the class, a `static` member, a `#private`
member, a computed name or an accessor; the script compile says so, with the line, if you try.

## Finding nodes: `@child` and `@find`

| Decorator | Fills the field with |
|---|---|
| `@child('Name')` | The nearest node called `Name` **under** this one. Breadth-first, so a direct child beats a deeper one of the same name. |
| `@child('Bar/Fill')` | A path: the nearest `Bar` under this node, then the nearest `Fill` under that. |
| `@find('Name')` | The node called `Name` anywhere in the scene (`findNode`). |

The field is filled **before `onConstruct`**, and once more before `onStart` while it is still empty —
so a node spawned by another script's `onConstruct` is found too. By `onStart` (and `onSpawn`, and
`onRestore`) the field is ready: no lookup in `onStart`, no cache.

- A field that already holds a node is left alone: a value you assigned, or one a save restored.
- A node that is not there leaves the field empty and logs one warning naming the field. Declare it
  `muzzle?: Node` when its absence is fine, and the warning is not raised.
- These fields are not inspector values: the Behaviors panel shows them as `Finds: muzzle → Muzzle`.

Use plain fields for state you compute, and `@child` / `@find` only for a **literal name**. A name that
comes from a field (`this.findNode(this.targetName)`), or a lookup repeated every call, stays code.

## Input: `@onAction`

```ts
@onAction('Jump') jump(state: ActionState) { … }               // pressed (the default)
@onAction('Jump', 'released') land() { … }                     // released
@onAction('Gameplay/Fire', 'changed') fire(state) { … }        // every change of the action
```

The method gets the action's `ActionState`. The name is the action's, or `Map/Action` to be exact. `when`
is `'started'` (the press, the default), `'released'`, `'performed'` (the action completing: on the press for
a tap, once held long enough for a hold) or `'changed'` (every change).

It works exactly like `onAction`, which a script may still have as well:

- the call comes just before that frame's `onUpdate`;
- **nothing is delivered while the game is paused** — a menu that must react while paused polls
  `Input.started(…)` from `scene.addLateUpdate`, as the example menus do;
- a throw (or a rejected promise) is logged and the frame carries on.

The name is checked against the project's input map: `@onAction('Jupm')` is an error in the script
editors, and the real names complete.

### Holds and taps: `@onHold` and `@onTap`

```ts
@onTap('Roll') roll() { … }                  // released within 0.25 s of the press
@onTap('Roll', 0.3) roll() { … }             // …or within 0.3 s
@onHold('Roll', 0.5) sprint() { … }          // once, 0.5 s into a press (the default)
```

A press shorter than a tap's limit is a tap, and gets no hold; a longer one fires its hold, and gets no
tap on release. A hold fires once per press. Both pass the action's `ActionState`, and neither is delivered
while the game is paused. They need no timer of your own: no `heldSeconds` copy kept for the release frame.

## Events and timers

```ts
@onEvent('PlayerDied') died(info) { … }      // GameEvents.emit('PlayerDied', info) anywhere
@every(0.5) think() { … }                    // every half second of unpaused game time
```

`GameEvents` is a small message channel for your game: `GameEvents.emit(name, payload)`,
`GameEvents.on(name, fn)` (returns the function that stops listening) and `GameEvents.off(name, fn)`. It
is not the engine's `engineEventBus`.

Both run **while the node is awake**: they start when it spawns and stop when it despawns or is removed,
so a gone node is never called, and a node that wakes again listens again. No setup in `onStart`, and no
cleanup in `onDespawn`.

## Triggers: `@onEnter` and `@onExit`

```ts
@onEnter('Player') hit(other: Node) { … }     // the Player (or anything carrying a 'Player' variable…)
@onEnter('isEnemy') alert(other: Node) { … }  // …or a node that set the variable 'isEnemy'
@onExit() leave(other: Node) { … }            // anything
```

The method runs for an overlap that `onTriggerEnter` / `onTriggerExit` would report, in 3D and 2D. The
filter is a node name or the name of a variable the other node holds, and matches on the other node or any
of its ancestors — so a Player inside "Player Collider" matches either way. No filter means anything.

## Inspector attributes: `@attribute`

Only a field marked `@attribute` shows in the inspector's **Behaviors** panel, whatever its access —
`public`, `protected` or `private`. Every other field is the script's own state: not shown, not stored per
node, not overridden by templates.

```ts
/** Hit points at full health. */
@attribute maxHp = 100                                   // the Attributes section
@attribute('Combat') damage = 10                         // a "Combat" section
@attribute('Combat', { min: 0, max: 1, step: 0.05 }) crit = 0.1
@attribute({ label: 'Tint', color: true }) private _tint: [number, number, number] = [1, 1, 1]
@attribute({ showIf: ['mode', 'ranged'] }) range = 8
@attribute({ readonly: true }) kills = 0
@attribute({ multiline: true }) bark = ''
```

- A **group** (the first argument, a string) gives the field a collapsible section of its own, titled with
  it; without one it goes in **Attributes**. Groups appear in the order their first field is declared.
- **Options**: `label`, `min` / `max` / `step` (a slider, values clamped), `readonly`, `showIf` (`'flag'`
  or `['field', value]`), `color` (an `[r, g, b]` colour picker), `multiline` (a text area).
- The field's **doc comment** is the row's tooltip.
- Arguments must be literals: the editor reads them without running the script, and ignores one it can't.

## Fields for the inspector and saves

| Decorator | Same as the doc tag | Meaning |
|---|---|---|
| `@save` | `/** @save */` | The field is kept by saves (see [Saving and loading](save-game.md)). |
| `@options('list')` | `/** @options list */` | A string field picked from the entries of the public `string[]` field `list`. |
| `@pick('clip')` | `/** @pick clip */` | A string (or `string[]`) field picked from the names of that kind a node can reach: `clip`, `sound`, `socket`, `template`, `node`, `trigger`, `spriteClip`. |

```ts
@save @pick('sound') cue: string = 'Hit'

weapons: string[] = ['Sword', 'Axe']
@options('weapons') weapon = 'Sword'
```

`@options('wepons')`, naming a field that is not a list, is a type error. The doc-comment tags still
work, so older scripts need no change; the typed name fields (`ClipName`, `SoundName`, …) are often the
simplest way to say the same thing as `@pick`.

## Good to know

- Decorators change nothing about how a script runs: the class is still never constructed, and its
  methods are still copied onto the node. They record what you wrote; the engine acts on it.
- A derived script inherits its base's decorators. Decorating the same field or method again overrides
  the base's.
- A decorator's arguments must be written out (`'Muzzle'`, not a variable): the editor reads them from the
  source without running it.
- Your own decorators work too. A method decorator may return a replacement method; field decorators have
  no instance to initialise, so one that returns an initializer, or calls `context.addInitializer`, is
  rejected with an error.
