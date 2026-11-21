# Events

Events let one part of a game tell the others that something happened without knowing who is
listening. A gun says it fired; the HUD, the sound and the score each hear it. Every event in Cleo
travels on one system, whether a script sends it, an animator fires it, or the engine announces it to
itself.

```ts
import { Node, Events } from 'cleo'
import { eventDispatch, eventListener, onEvent } from 'cleo/decorators'

export default class GunNode extends Node {
  // Each call sends 'Shot' with what the method returned.
  @eventDispatch('Shot') fire() { return { damage: 10 } }
}

export default class PlayerNode extends Node {
  // Hears 'Shot' from the gun under it, and from no other player's gun.
  @eventListener('Shot') shot(result) { this.ammo-- }
}

export default class ScoreNode extends Node {
  // Hears every 'Shot' in the game, from anywhere.
  @onEvent('Shot') count(result) { this.shots++ }
}
```

## Channels

An event belongs to a **channel**, and only that channel's listeners hear it. Write the name as
`'channel:Name'` to pick a channel; a name without a colon is on the `game` channel.

| Channel | What travels on it |
|---|---|
| `game` | What scripts send each other. The default. `GameEvents` is this channel. |
| `animation` | What animators fire: clip markers, `StateEnter`, `StateExit`, `ActionFinished`, `ClipFinished`, `TriggerStarted`, `TriggerEnded`. |
| `animator` | Commands to animators, sent down from a node: `SetTrigger`, `SetParam`, `PlayAction` and the rest (see [Commanding the animator](#commanding-the-animator)). |
| `engine` | The engine's own traffic: `SCENE_CHANGED`, `LOG`, `NODE_DIRTY` and the rest. `engineEventBus` is this channel. |
| any other name | Made the first time it is used: `'ui:ScoreChanged'`, `'combat:Hit'`. |

```ts
Events.emit('combat:Hit', target, 10)       // the combat channel
@onEvent('combat:Hit') hit(target, damage) {} // hears it
@onEvent('Hit') other() {}                   // does not: that is the game channel's Hit
```

Only the first colon separates, so `'ui:menu:open'` is `menu:open` on `ui`.

## Who hears an event

An event sent with `Events.emit` is a **broadcast**: every listener on its channel hears it, wherever
it is.

An event can also be sent **down** (`this.dispatchDown`, or `{ down: true }`): it is heard at the node, then
at every node beneath it, depth first (phase `'descend'`), then by the channel's listeners. It is how a
character commands what it holds, such as the animators under it.

An event dispatched **at a node** (`this.dispatchEvent`, or `@eventDispatch`) travels the way a click
travels through a web page:

1. **Capture**, from the root of the tree down to the node's parent. Only listeners added with
   `capture: true` hear it here.
2. **Target**: the node itself.
3. **Bubble**, back up from the node's parent to the root.
4. **Broadcast**: the channel's own listeners (`@onEvent`, `Events.on`), last, from anywhere.

So `@eventListener` on a character hears what its model, its weapon and its hitboxes dispatch, and
nothing from any other character. `@onEvent` hears every one of them.

A listener can stop the event going any further:

```ts
@eventListener('Damage', { capture: true })
shield(amount) {
  if (this.blocking) Events.current.stopPropagation()   // the node that was hit never hears it
}
```

`Events.current` is the event whose listener is running: `target` (the node it was dispatched at),
`currentTarget` (the node listening now), `phase`, `results` (what earlier listeners returned),
`stopPropagation()` and `stopImmediatePropagation()`.

## Sync, async and deferred

Each event is delivered in one of three ways. All three reach the same listeners.

| How | Call | When listeners run |
|---|---|---|
| Sync | `Events.emit(name, ...args)` | Now, inside the call, highest priority first. |
| Async | `await Events.emitAsync(name, ...args)` | One after another. Each listener's promise is awaited before the next runs. `emitParallel` starts them all at once. |
| Deferred | `Events.post(name, ...args)` | At the frame's event flush: after every node has updated, before the cameras and the drawing. |

Deferred events wait while the game is paused, as timers do. One posted while the flush is running
waits for the next frame, so a listener that posts what it hears cannot hang the game.

Listeners may return a value. `emitAsync` and `emitParallel` resolve to what they returned, and
`Events.request(name, ...args)` returns the first value a listener gave:

```ts
@onEvent('Price') price(item) { return item === 'sword' ? 30 : undefined }
const cost = Events.request('Price', 'sword')     // 30
```

To wait for an event in an async method, use `Events.next`:

```ts
async onStart() {
  const boss = await Events.next('BossSpawned')
  const phase2 = await Events.next('BossPhase', { where: { phase: 2 }, timeout: 60_000 })
}
```

## The decorators

All of them come from `cleo/decorators`, and all of them listen only **while the node is awake**:
they start when it spawns and stop when it despawns or is removed. A node that wakes again listens
again. There is nothing to set up in `onStart` and nothing to clean up in `onDespawn`.

### `@onEvent(name, options?)`

Hears an event on its channel, sent from anywhere. The method is called with the event's arguments.

```ts
@onEvent('PlayerDied') died(info) { … }
@onEvent('Died', { where: { team: 'red' } }) redDied(info) { … }  // only when info.team is 'red'
@onEvent('Died', { once: true }) firstBlood(info) { … }           // once per life of the node
@onEvent('Hit', { channel: 'combat', priority: 10 }) early() { … } // before priority-0 listeners
```

### `@eventListener(name, options?)`

Hears an event dispatched at this node or at a node beneath it. It takes the same options as
`@onEvent`, plus `capture`.

```ts
@eventListener('Opened') opened(door) { … }
@eventListener('animation:footstep') step(info) { … }
```

### `@eventDispatch(name, ...extras)`

Sends an event each time the method runs. The event is dispatched at this node, with what the method
returned, followed by the extras:

```ts
@eventDispatch('Shot') fire() { return { damage: 10 } }           // listeners get ({ damage: 10 })
@eventDispatch('Shot', 'pistol') fire() { return { damage: 10 } } // listeners get ({ damage: 10 }, 'pistol')
```

- The caller still gets the method's return value.
- An `async` method's result is awaited before the event is sent.
- To send nothing on one call, return `Events.cancel`. The caller then gets `undefined`. Returning
  `false` does not cancel: a method that returns a flag still sends it.

The long form takes options:

```ts
@eventDispatch({ name: 'Saved', mode: 'async' }) save() { … }      // resolves once every listener has finished
@eventDispatch({ name: 'ui:Score', mode: 'deferred' }) score() { … }// heard at the frame's event flush
@eventDispatch({ name: 'Rung', to: 'all' }) ring() { … }           // on every machine of an online game
@eventDispatch({ name: 'Local', bubbles: false, broadcast: false }) // this node's listeners only
```

### `@observable` and `@observable(name)`

Sends an event at the node whenever the field is set to a different value, with `(value, previous)`.
The event is `<field>Changed` unless you name it.

```ts
@observable hp = 100                       // 'hpChanged'
@observable('ui:ScoreChanged') score = 0

// On the node or an ancestor, such as the character's health bar:
@eventListener('hpChanged') bar(hp, was) { this.fill = hp / 100 }
```

Only a new value counts. An array or object changed in place is the same value, so assign a new one:
`this.items = [...this.items, item]`.

### `@onClipEvent(name, clip?)`

Hears an animation event marker on a clip, reached by this node's animator or by an animator beneath
it (the character's model). See [Animation](animation.md#events).

```ts
@onClipEvent('footstep') step(info) { this.playFootstep(info.clip) }
@onClipEvent('hit', 'Heavy Attack') heavyHit(info) { … }
```

## Without decorators

| Code | Does |
|---|---|
| `Events.emit / publish / emitAsync / emitParallel / post` | Send on a channel (`publish` returns the event, with its `results`). |
| `Events.on(name, fn, options?)` | Listen. Returns the function that stops listening. Options: `once`, `priority`, `where`, `replay`. |
| `Events.once / off / next / request / requestAsync` | The rest. |
| `Events.emitSticky(name, ...args)` | Send, and keep the arguments: a listener added later with `{ replay: true }` hears them at once. Use it for states such as "the level is loaded". |
| `Events.send(name, args, { mode, to })` | Send with every option. |
| `Events.route('animation:footstep', 'audio:step')` | Forward one channel's event to another, or to a function. |
| `Events.channel('combat')` | A channel itself: the same methods, without the `channel:` prefix. |
| `this.dispatchEvent(name, ...args)` | Dispatch at this node, now. `dispatchEventAsync` awaits the listeners. |
| `this.sendEvent(name, args, options)` | Dispatch at this node with every option. |
| `this.addEventListener(name, fn, options?)` | Listen at this node. Kept through despawns, as a web page element keeps its listeners. |
| `this.listen(name, fn, options?)` | `Events.on`, released for you when the node despawns or is removed, as `this.after` timers are. |
| `GameEvents.emit / on / off` | The original one-payload form of the game channel. It hears and sends the same events. |

A listener added with `Events.on` or `GameEvents.on` stays until it is removed. It does not stop when
your node despawns. Prefer `this.listen` or a decorator. Every listener a game added is dropped when
the game stops, and when it starts again.

A listener that throws is reported in the console with the event's name, and the other listeners
still run.

## Animation events

Animators fire on the `animation` channel, at the node the animator belongs to (the model). Events
bubble up from there, so the character's script hears its own animator.

| Event | When | Arguments |
|---|---|---|
| The marker's name | A clip's event marker is reached | `{ event, clip, state, layer, node, animator }` |
| `StateEnter` / `StateExit` | The machine enters or leaves a state, on any layer | `{ state, from, to, layer, node, animator }` |
| `ActionFinished` | A `playAction` one-shot is over: faded out, replaced or stopped | `{ clip, layer, node, animator }` |
| `ClipFinished` | A sprite's once-clip reaches its end | `{ clip, node }` |
| `TriggerStarted` / `TriggerEnded` | The states a trigger led into begin, and are over (the layer back in its entry state, or another trigger's) | `{ trigger, state, layer, node, animator }` |

Markers are delivered **during** the animator's update, like `onAnimationEvent` callbacks.
`StateEnter`, `StateExit`, `ActionFinished`, `ClipFinished` and the trigger events wait for the frame's
event flush. That way a listener that sets a trigger or forces a state never re-enters the machine in
the middle of a transition.

`TriggerEnded` is how a script knows a one-shot it fired is over, without polling `activeTrigger()`
every frame:

```ts
@eventListener('animation:TriggerEnded')
private _triggerEnded(info) { if (info.trigger === this.exitTrigger) this.standUp() }
```

## Commanding the animator

A script does not reach for its character's animator to call it. It sends a command **down** from its
own node on the `animator` channel, and every animator beneath that node obeys: the skeletal animator on
the character's model, or an Animated Sprite. The decorators do this for you:

```ts
@animTrigger('Jump') jump() { … }                  // each call fires Jump
@animTrigger() getIn() { return this.enterTrigger } // the trigger a field names
@animAction('Wave') wave() { … }                   // a one-shot in a slot (a sprite: play the clip)
@animAction() swing(n) { return { clip: 'attack' + n, restart: true } }
@animParam('Moving') moving = false                // each new value goes to the parameter
```

- **`@animTrigger(name?)`** fires a trigger each time the method runs. With no name, the method's return
  value names the trigger; returning nothing fires none.
- **`@animAction(clip?, options?)`** plays a one-shot each time the method runs. With no clip, the method
  returns the clip name, or `{ clip, ...options }`.
- **`@animParam(name?)`** sends the field's value to a parameter whenever it changes, and once when the
  node spawns. Set it every frame if you like: only changes are sent. A parameter the animator already
  reads from the node (a Linked parameter) needs none of this.

In all three, returning `Events.cancel` sends nothing, an async method's value is awaited first, and the
caller still gets the method's own return value.

Without a decorator, send a command yourself: `this.dispatchDown('animator:SetTrigger', 'Jump')`. Its
`results` hold what the animators returned, for example the handle of a `PlayAction`.

| Command | Arguments | Skeletal animator | Animated Sprite |
|---|---|---|---|
| `SetTrigger` | name | `setTrigger` | `fireTrigger` |
| `ResetTrigger` | name | `resetTrigger` | the parameter set false |
| `SetParam` | name, value | `setFloat` / `setBool` | `setParam` |
| `OverrideParam` | name, value or `null` | `setParamOverride` | — |
| `PlayAction` | clip, options | `playAction` (returns the handle) | `play(clip, options.restart)` |
| `StopAction` | slot?, blendOut? | `stopAction` | — |
| `ForceState` | state, blend? | `forceState` (returns whether it could) | — |
| `FireEvent` | name | `fireEvent` (the machine's Event Actions) | — |
| `Resume` | — | — | `resumeMachine` |

A command goes to every animator under the node it is sent from. To reach just one, such as the current
weapon's viewmodel, send it from that node: `view.dispatchDown('animator:SetTrigger', 'Reload')`.
Reading the animator stays a read: `triggerInfo`, `activeTrigger`, `getParam` and `currentTime` answer
questions and change nothing.

Animators listen as the engine, not as scripts. A scene full of animators still has
`hasScriptListeners()` false, and the animators' per-frame checks stay closed until a script listens to
something.

A marker named `'channel:name'`, such as `combat:contact`, is sent on that channel instead of
`animation`.

## Over the network

In a NetSync game, `to` sends an event to other machines (see [Multiplayer](multiplayer.md)):

- `'host'`: the host only.
- `'peers'`: every player's machine.
- `'all'`: everyone.

```ts
@eventDispatch({ name: 'Rung', to: 'all' }) ring(by) { return by }
Events.send('RoundOver', [winner], { to: 'all' })
```

An event dispatched at a node arrives dispatched at each machine's copy of that node. Each machine
hears it once, including the one that sent it, if it is one of the `to`. Offline, `to` changes
nothing: the event is delivered here.

## For engine code: the engine channel

The engine uses the same system for its own traffic. Its listeners are the engine's and the
editor's own code, so a listener that throws is not caught on this channel.

- `engineEventBus` (and `CleoEngine.eventEmitter`) is a typed view of the `engine` channel. The
  events it carries are listed in [Scene and game](scene-and-game.md#the-event-bus).
- `node.markDirty(aspect)` is how engine code says that something about a node went stale. The aspect
  is one of `'transform'`, `'bounds'`, `'lists'`, `'geometry'`, `'material'` or `'render'`.
  - It does at once whatever keeps the node itself correct: it dirties the world bounds caches, or has
    the scene rebuild its node lists.
  - Then it posts `NODE_DIRTY { node, aspects, scene }`. This arrives once per node per frame, with
    every aspect together, after the scene's update and before the frame is drawn. It is never
    posted while nothing listens.
  - Anything else that caches something about a node listens there, instead of being called from the
    node.

```ts
engineEventBus.on('NODE_DIRTY', ({ node, aspects }) => {
  if (aspects.has('bounds')) selectionOutline.refresh(node)
})
```

Hot paths ask before they build an event: `channel.hasListeners(name)`, `hasScriptListeners()`. An
event that nobody listens to costs a map lookup.

## What it costs

These figures were measured on the engine as the player and the editor build it, on a desktop PC,
against the engine before this event system:

| What | Cost |
|---|---|
| An emit nobody listens to | 6–20 ns. It builds nothing. |
| An emit with one listener | 60–100 ns. That is 25–60 ns more than the old emitters, for error isolation, priorities, `once`, `where` and `Events.current`. |
| A dispatch at a node 8 deep, with one listening ancestor | About 200 ns. A dispatch nobody listens to at any node costs the same as a broadcast. |
| A frame of 2000 nodes, or of 200 animators | The same as before. |
| Subscribing and unsubscribing 10,000 listeners | Faster than before. Removing a listener is O(1). |

A dispatch allocates nothing of its own. The event object is made only if a listener reads
`Events.current`, or if the caller asks for it back (`publish`, `dispatchEvent`). The results array
is made only if a listener returns something. Only the argument list you pass is allocated.

Memory is let go with the node. When a scene is disposed, its nodes' decorated listeners, their
`this.listen` subscriptions, the listeners added at them, and any deferred event still queued about
them are all released, and the scene is collected. The engine before this kept every disposed scene
whose scripts used `@onEvent`, and kept calling their handlers. `Events.on` and `GameEvents.on`
listeners added by hand are dropped when the game stops or starts. The deferred queue holds at most
50,000 events per channel. The cache of resolved event names holds at most 4,096.
