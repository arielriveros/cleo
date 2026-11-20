# Firing Line (the FPS example)

A first-person shooter built from templates: put a **FPS Game Manager** and some fighters in any scene and it
plays. An example project (see `tools/fps/README.md`); scripts are `examples/scripts/Fps*.ts`.

## The scene

One scene, **Firing Line**: the player against three bots in a walled yard with cover, flood lights, baked global
illumination, sky, clouds, weather and wind. Everything in it is made of templates, so the same pieces work in
any scene.

The yard is dressed with placeholder props under `Level > Props`: pallets, tires, drums, sandbag walls, dumpsters,
generators, fuel tanks, cable spools, tarp stacks, tables, fences, planters, rubble, bollards and signs. Each is one
box or cylinder node named `Prop <Kind> NN`, sized like the real thing and with its own collider, so a final model
of the same size can replace it (swap the node's model, keep the transform and collider). The larger ones have an
`FPS Cover Point` beside them. After changing props, rebake the navigation mesh and the global illumination.

## Using it in your own scene

Copy these templates in (Assets > FPS):

- **FPS Game Manager** - one, at the scene root. Pick the **game type** from its dropdown, then set
  `scoreLimit`, `timeLimit`, `friendlyFire`. It finds every fighter in the scene, deals them into teams, places
  them on the spawn points, scores kills, respawns the dead and restarts the match.
- **FPS Player** - one. First-person camera, three weapons, HUD.
- **FPS Bot**, **FPS Vanguard**, **FPS Raider**, **FPS Swat** - as many as you like. Override `skill`,
  `weapon` (`pistol`, `ak47`, `shotgun`), `displayName` on an instance.
- **FPS Spawn Point** (optional) - where fighters start and come back. None: they stay where they are placed.
- **FPS Cover Point** (optional) - a spot a bot may duck behind. None: bots find cover themselves.
- A baked **Nav Mesh** (optional): bots walk it; without one they walk straight lines.

### Game types

| Game type | Teams | Fighters it needs |
|---|---|---|
| One against all (`oneVsAll`) | the player against everyone else | 12 |
| Team deathmatch (`teamDeathmatch`) | two teams, split down the middle | 12 |
| Free for all (`ffa`) | everyone for themselves | 12 |
| Co-op (`coop`) | the players against the bots | 12 offline; online, the players plus `coopBots` |

If the scene holds fewer fighters than the game type needs, the manager spawns the missing bots at spawn points
from its `botTemplates` list (the four bot templates, in turn). A scene with more bots than that simply plays
with all of them: put a manager set to Free for all and two bot instances in a scene and it is a free for all
with two bots (plus the fill-in bots, if two is under the minimum - set `botTemplates` empty to switch the
fill-in off).

## Online

Firing Line is also an online game ([Multiplayer](multiplayer.md)): its project has **Online play** on, with
**FPS Player** as the player template. Try it with **Play › Multiplayer** (the dev host running, two players or
more). The game mode comes from the session — what a player asked the allocator for (`?mode=coop`, `?mode=deathmatch`)
or the project's **Game mode** — over the manager's `gameType`:

- **Co-op** (`coop`): every player on Blue, a horde of `coopBots` bots on Red (24 by default; the host runs about
  50 within its budget).
- **Team deathmatch** (`deathmatch`): `onlineTeamSize` a side (8 against 8). Players are spread over the two
  teams and bots take the seats left; a player who joins takes a bot's place, and one who leaves gets a bot back.
- **Free for all** (`ffa`): everyone alone, bots filling up to sixteen.

The level's own player character (the one the offline game is played with) is removed when an online match starts:
each player brings their own. At the end of a match, the next one starts where everyone is, rather than reloading
the scene.

### How the scripts share the work

The same scripts run on the host and on every player's machine; each decides by `this.net` what is its to do. They
are a pattern for any online shooter ([Scripting › Multiplayer](../scripting/multiplayer.md)):

| | Where | How |
|---|---|---|
| Moving, looking, crouching | the player's machine, predicted; the host replays it | the Controller's intent (crouch is its `Crouch` action) |
| Aiming, firing, reloading (they slow the player) | the player's machine | `stance(aim, firing, reloading)`, a `@netcall` to the host when it changes |
| A shot | decided on the player's machine, judged by the host | `shot(origin, dir, spread, weapon, this.net.viewTick)` to the host, which fires the bullet inside `this.net.rewound(...)`: against the world as the player saw it |
| Health, death, kills, team, name | the host | `@synced` fields on FpsCombatant; `onDeadSeen` plays a death the host decided |
| Hit marker, the hurt shake, respawn, facing after a respawn | the host tells the player's machine | `hitMarker`, `hurtFeedback`, `respawned`, `teleported`: `@netcall({ to: 'owner' })` |
| The match: teams, bots, score, clock, feed | the host | FpsGameManager; its score, team names, feed, clock and banner are `@synced` for the HUDs |
| Bots | the host | FpsBot returns at once on a player's machine: it is drawn where the host has it, animated by the host's animator parameters |
| The viewmodel, the camera, the HUD, depth of field | the player's machine | shown only where `this.net.isOwner` |

The magazine is the player's machine's, and the host trusts it: the host refuses a shot only when the player is
dead, carries no such weapon, fires from more than 3.5 m away from where the host has it, or faster than the
weapon fires.

## What the bots do

Patrol, search (where a target was last seen, a shot was heard, or a teammate called from), engage (hold a
distance, strafe, crouch at range, shoot in bursts), take cover when hurt, retreat when badly hurt (calling
their team for reinforcements, reloading and waiting out of sight), and die with a random death clip matched
to where the shot came from before going ragdoll. The Brain asset is a three-state graph over one number the
script publishes (`navMode`); the decisions are in `FpsBot.ts`.

## Controls

Move W A S D, look with the mouse (click to capture), Fire left mouse, Aim right mouse, Reload R, Sprint
Shift, Crouch C, Jump Space, weapons 1 2 3 or Q / E. A gamepad is bound too (`tools/fps/inputMap.mjs`).

## The viewmodel

The arms and weapon are drawn with [`Node.viewmodel`](../scripting/node-api.md#viewmodel): a narrower lens than
the world's, and pulled clear of walls by `FpsPlayer._viewmodelClearance`.

## Effects from animation events

The shot, reload, equip and death effects are not in the scripts. The weapon clips carry markers (`shot` on
`Fire` / `AimFire`, `reload` on the reload clip, `equip` on `Equip`; `death` on the bot death clips) and each
controller binds them in its **Event actions** (Animator editor, Variables panel): the weapon's sound and the
`FPS Muzzle Flash` template, spawned on the viewmodel's `Muzzle` where it is drawn and kept there while it lives.
Bots have no fire clip, so `FpsBot` fires `shot.<weapon>` by name and its controller binds the same effects.
Hit-position effects (impact, blood, tracer, bullet hole) and the player's hurt/hit/kill/empty sounds stay in
`FpsCombatant` / `FpsPlayer`, because they depend on where a ray landed. The markers and bindings are applied by
`tools/fps/eventActions.mjs` on every ingest.

## Aiming

Holding Aim softens the background with depth of field (`FpsPlayer._depthOfField`): the focal plane follows the
crosshair, and [`dofNearCutoff`](../reference/render-settings.md) keeps the weapon sharp. The effect is only
enabled while aiming, so it costs nothing otherwise. Tune it on the player: `dofAperture`, `dofMaxBlur`,
`dofNearCutoff`.

## Performance notes

The example's look is tuned to stay cheap in the lighting pass: sun shadows at 2048 x 3 cascades out to 80 m, one
ground-fog volume (no local-light shadows in the fog, tile size 20), a light probe baked once at load rather than
realtime (a realtime probe recaptures its cube every second), and at most three muzzle-flash lights alive at once
(`FpsFx.ts`; the rest of a flash is particles). Measured headless with the GPU profiler, during a firefight:
`lighting` averaged about 0.7 ms with a 3 ms worst frame (before: 1.2-1.5 ms average, 3 ms worst).

## Updating the example

The example is a project exported from the editor (see `tools/fps/README.md`). Edit it in the editor, Export,
and run `node --max-old-space-size=12288 tools/fps/ingest.mjs <zip>`. The scripts are the one thing the repository
owns: edit `examples/scripts/Fps*.ts`, then run `node --max-old-space-size=12288 tools/fps/ingest.mjs --scripts-only`.
