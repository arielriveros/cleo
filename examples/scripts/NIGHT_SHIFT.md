# Night Shift — a complete example game

Scavenge a forest before dawn. Zombies spawn through the night and hunt you; at sunrise they catch fire
and burn. Reach 06:00 alive and the level ends with a score panel offering Continue or Exit.

It ships as the **Night Shift** example project (`editor/public/examples/night-shift/`), and it is built
on the third-person strafe character documented in [README.md](README.md) — read that first, because
everything here assumes a working Playable.

## What is where

| | |
|---|---|
| The nine gameplay scripts | `examples/scripts/NightShift*.ts` |
| The project generator | `tools/nightShift/build.mjs` |
| The sprite packer | `tools/nightShift/packSprites.py` |
| Behaviour tests | `tests/nightShift.test.ts` |
| Project-structure tests | `tests/nightShiftProject.test.ts` |

```
npm run build && npx tsc -p examples/scripts/tsconfig.json    # the scripts type-check
npm test                                                       # both suites
node tools/nightShift/build.mjs                                # regenerate the project
npm --prefix editor run examples:list                          # refresh the gallery index
```

The generator is deterministic — every id is derived from a fixed seed — so re-running it produces
byte-identical output and only real changes show up in a diff.

## The scripts

| script | on | owns |
|---|---|---|
| `NightShiftDirector` | `GameManager` | the clock, the sun, score, and deciding the level is over |
| `NightShiftPlayer` | `Playable` | health, the `isPlayer` marker, powerup countdowns, dying |
| `NightShiftZombie` | the Zombie root | dealing damage, burning, the ragdoll death |
| `NightShiftZombieBrain` | the Zombie's `Brain` | target acquisition — see below |
| `NightShiftSpawner` | `ZombieSpawner` | the difficulty curve and placement |
| `NightShiftPickup` | score pickups | scoring once, spinning and bobbing |
| `NightShiftPowerup` | the three powerups | speed, invincibility, the AoE blast |
| `NightShiftHud` | `HUD` | binding clock / health / score / pips |
| `NightShiftEndScreen` | `EndScreen` | the result panel and its two buttons |

Every tunable is a public field, so it is editable per node in the inspector without touching a file.

## The three things that decide whether this works

### There is no faction system

`ControllerNode.perceive` offers **every other Character in the scene** as a perception candidate, and the
built-in `autoAcquire` takes the nearest *noticed* one. Zombies are Characters — so left alone, zombies
target each other and the horde mills around itself while you walk past.

The Zombie template therefore sets `autoAcquire: false`, and `NightShiftZombieBrain.onThink` acquires
instead, filtered to nodes carrying an `isPlayer` variable. A held target is kept until `timeSinceSeen`
passes `perception.memorySpan`, which is what lets `investigate` mean anything — drop it the frame line of
sight breaks and the zombie forgets you the instant you round a corner.

Note `sightingOf` is **not** exposed on `ControllerNode` (only on `Perception`, which is private), so the
brain iterates `this.sightings` instead.

### The sky re-bake

The atmosphere bakes six cube faces plus a mip chain whenever the sun moves, and the only throttle is
angular — about 0.3°. Writing `sunDirection`, `sunColor`, `sunIntensity`, the sky node's `exposure` or
`groundColor` sets the bake flag **unconditionally**, and that check short-circuits ahead of the angular
one, so touching any of them per frame bakes per frame.

So the director never touches those. It rotates the directional light, which `useSceneSun` reads, on a
0.25 s timer. Renderer exposure, saturation and vignette are a different surface and are free, so the
dusk-to-dawn mood rides those every frame.

Sky *ambient* is a second trap: the SH projection decides it is stale by comparing cubemap object
identity, and the re-bake renders into the same texture — so indirect light freezes at the first sun
position unless something calls `skyLight.markDirty()`. The director does, every 2 s.

### Timers die with their node

`despawn()` and `remove()` cancel a node's timers *before* `onDespawn` fires. A "give the speed back in 8
seconds" timer scheduled on the pickup that just removed itself never runs, and the player keeps the buff
for the rest of the level. Powerup countdowns therefore live on the **player**, ticked in its `onUpdate` —
which also gives the HUD pips something to draw.

## Built differently from the design, and why

There is exactly one skinned humanoid in the repo and **no attack or death clip anywhere**. Three
consequences:

| designed | built |
|---|---|
| A distinct zombie model | The player mannequin, tinted and emissive, shambling at `speedScale 0.3` |
| An attack clip with a `hit` event marker | Damage on a cooldown while the brain holds `Attack`; the pose stays Idle |
| `playAnimationByName('Death')` | `physics.startRagdoll(model)` — the mannequin's ragdoll is already configured |

Burning is unchanged, because all three layers already existed: an emissive ramp on the per-instance
material, the `fire.png` billboard reused from the Torch, and a flickering point light with shadows off.

The zombie's copy of the mannequin **drops 15 of its 17 clips**. A shambler plays Idle and Walk; the
strafe, turn and jump clips are 10 MB of animation nothing here would ever reach.

## Building the level up

Each stage is playable on its own. Do not skip ahead.

1. **Character.** `W → 0`, `D → −90`, `A → +90`, `S → ±180`; turn-in-place at 90° and 135°.
2. **Clock.** The sun sweeps and the HUD reads 22:00 → 06:00 over 180 s. Watch the frame time — periodic
   spikes are the sky re-bake doing its job; a *constant* stall means a per-frame setter is forcing it.
3. **Pickups.** Score rises, and walking back and forth over one does not double-count.
4. **HUD.** Resize the window; it should scale, not drift.
5. **End screen.** Force `t = 1`. The panel appears, gameplay freezes, and both buttons still respond.
6. **One zombie.** Press **Play** — perception is skipped while authoring, so it does nothing in the
   viewport. That is not a bug. It should acquire you only inside its cone and range, lose you behind the
   house, investigate your last position, and never target another zombie.
7. **Navmesh.** Select `Nav Mesh` → Bake. Until then `path` falls back to a straight-line seek, so the
   level is playable either way and gets better once baked. The bake reads **colliders, not meshes**.
8. **Burn.** Force day. Every zombie ignites, ragdolls and despawns, and one zombie's emissive does not
   change the others'.
9. **Full loop.** Play a level, Continue, and confirm the spawn rate rose.

## Wiring left for the editor

The **Main Menu** scene's Play button has no script attached. A menu is the one place a designer will
certainly want to change the wording and the destination, so it is left as a two-line
`onPress() { Game.loadScene('Night Shift') }` to add in the Script panel.

## Asset licensing

The pickup sprites are packed from `examples/assets/PixelPlatformerSet1v.1.1.zip`, a third-party pack that
lives in a **gitignored** folder — so it currently ships with nothing. Committing the packed atlases under
`editor/public/examples/night-shift/textures/` redistributes that artwork. **Check the pack's licence
before pushing this.** If redistribution is not permitted, swap the pickups for code-generated primitives
(`Geometry.Sphere` / `Cube` with an emissive PBR material), which needs no art and no licence — the
pickup and powerup scripts are unchanged either way.
