# Firing Line (the FPS example)

A first-person shooter built from templates: put a **FPS Game Manager** and some fighters in any scene and it
plays. An example project (see `tools/fps/README.md`); scripts are `examples/scripts/Fps*.ts`.

## The scene

One scene, **Firing Line**: the player against three bots in a walled yard with cover, flood lights, baked global
illumination, sky, clouds, weather and wind. Everything in it is made of templates, so the same pieces work in
any scene.

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
| One against all (`oneVsThree`) | the player against everyone else | 4 |
| Team deathmatch (`team2v2`) | two teams, split down the middle (the player and the first bot against the rest) | 4 |
| Free for all (`ffa`) | everyone for themselves | 4 |

If the scene holds fewer fighters than the game type needs, the manager spawns the missing bots at spawn points
from its `botTemplates` list (the four bot templates, in turn). A scene with more bots than that simply plays
with all of them: put a manager set to Free for all and two bot instances in a scene and it is a free for all
with two bots (plus the fill-in bots, if two is under the minimum - set `botTemplates` empty to switch the
fill-in off).

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
