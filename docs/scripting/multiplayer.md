# Multiplayer

In an online game ([Multiplayer](../editor/multiplayer.md)) every script runs on the **host** and on every
**peer** (a player's machine). The host decides what happens; a peer shows the host's world and predicts its own
player's character. Most scripts need nothing new: characters, props with mass, their animation, carrying and
shooting are synced by the engine. What follows is for game rules a script keeps itself: a door, a score, a
pickup, a weapon.

The same code runs offline, where a game is its own host: `this.net.isHost` is true, `@synced` fields are plain
fields and `@netcall` methods simply run.

## Where am I: `this.net`

| | |
|---|---|
| `this.net.online` | In a session (host or peer). False offline. |
| `this.net.isHost` | This machine decides: the host, or any offline game. |
| `this.net.isPeer` | A player's machine in a session. |
| `this.net.peerId` | This machine's player number (0 on the host and offline). |
| `this.net.owner` | The player who owns this node (it is in their character's tree), 0 for the host's own. |
| `this.net.isOwner` | This machine controls this node: its player's character (on a peer), anything else (on the host). |
| `this.net.caller` | On the host, inside a `@netcall` a player made: that player's number. |
| `this.net.emit(name, payload, to)` | Raise a game event on other machines (below). |

Decide game rules on the host, and let peers show the result:

```ts
onTriggerEnter(other) {
  if (!this.net.isHost) return      // the host decides pickups (offline, this machine is the host)
  this.giveAmmo(other)
}
```

## Fields every player sees: `@synced`

```ts
import { Node } from 'cleo'
import { synced } from 'cleo/decorators'

export default class Door extends Node {
  @synced({ onChange: 'swing' }) open = false
  swing(was: boolean) { /* play the sound, start the animation */ }
}
```

Set a `@synced` field **on the host**; every peer gets the new value, in order and for sure, and a player who
joins late gets the value as it is now. `onChange` names a method run on each peer when a new value arrives (only
when it changed), with the previous value. Numbers, booleans, strings, arrays, plain objects and node references
travel; a node reference arrives as that player's own copy of the node. A peer setting one changes only its own
copy until the host's next value.

## Methods that run elsewhere: `@netcall`

```ts
import { netcall } from 'cleo/decorators'

@netcall({ to: 'host' }) fire(target: Node | null) {        // a player's machine asks; runs on the host
  if (target) this.damage(target)
  this.flash()
}
@netcall({ to: 'all', reliable: false }) flash() { … }     // the host tells everyone; may be lost (an effect)
@netcall({ to: 'owner' }) hint(text: string) { … }         // the host tells this node's player
```

- `to: 'host'` — called on a player's machine, it runs on the host, **if that player owns the node**. Add
  `anyone: true` for things any player may use (a door, a button). On the host, `this.net.caller` says who called.
- `to: 'all'` — called on the host, it runs there and on every peer.
- `to: 'owner'` — called on the host, it runs on the machine of the player who owns the node.
- `reliable: false` sends it on the fast lane, where it may be lost: for effects, never for game state.

The arguments travel like `@synced` values. A peer calling a `to: 'all'` or `to: 'owner'` method is ignored (only
the host tells others), with a warning in the console.

## Events: `Net.emit`

`this.net.emit('Cheer', { from: 'A' }, 'all')` (or `Net.emit` from code that is not a node's script) raises the
game event on other machines, where `@onEvent('Cheer')` methods and `GameEvents` listeners receive it. `to` is
`'all'` (the host and every peer, the default), `'peers'` or `'host'`. A peer's event to `'all'` reaches the host,
which passes it on to the other peers. Offline it does nothing; raise it locally with `GameEvents.emit` as usual.

## Random numbers: `Game.random`

Roll gameplay dice (loot, spread, AI choices) **on the host** with `Game.random()`, and sync the result: a roll
made on every machine would come out differently on each. `Game.seedRandom(seed)` restarts the stream, to replay
a run.

## Gotchas

- A node no player owns is the host's: on a peer, `isOwner` is false for it, so its `to: 'host'` netcalls need
  `anyone: true`.
- `onChange` does not run on the host (it set the value) and not for the value a node starts with.
- A script that moves a node every frame on every machine fights the host's updates for it: move synced nodes on
  the host only (`if (!this.net.isHost) return`).
