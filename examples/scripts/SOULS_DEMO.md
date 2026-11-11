# Dungeon — the souls-like example game

*Dungeon* is the engine's example game: a souls-like in a three-level torch-lit dungeon. The mechanics are
all real; the characters are not final art. The enemies are the engine's mannequin and scanned characters
in tinted materials, the player a scanned knight, and the combat clips are Mixamo motions plus a few
procedural stubs. The level is real content — a medieval dungeon structure, chunked, with box colliders,
torches and fire pits, cages, bookcases and racked weapons. This document covers how the game works and how
to replace each placeholder with final art from inside the editor, without touching a script.

The souls content (characters, weapons, enemies, bonfire, UI) is authored by `tools/soulsDemo/build.mjs`;
the level around it by `tools/valley/build.mjs` (`tools/valley/dungeon/`). The game used to be played on
the outdoor valley too, with the dungeon under its skull cave; the valley now ships as its own example, as
scenery. Before that the souls content shipped as a walled blockout level called *Hollow Keep*.

- [1. Opening and playing](#1-opening-and-playing)
- [2. Controls](#2-controls)
- [3. What is in the level](#3-what-is-in-the-level)
- [4. How the scripts fit together](#4-how-the-scripts-fit-together)
- [5. The asset manifest — every placeholder and what replaces it](#5-the-asset-manifest)
- [6. Animation contract — clips, events, state machine](#6-animation-contract)
- [7. Sockets and weapon grips](#7-sockets-and-weapon-grips)
- [8. Sound cues](#8-sound-cues)
- [9. Visual effects](#9-visual-effects)
- [10. UI widgets](#10-ui-widgets)
- [11. Step-by-step swap procedures](#11-step-by-step-swap-procedures)
- [12. Tuning reference](#12-tuning-reference)
- [13. Regenerating the example, tests, limitations](#13-regenerating-the-example-tests-limitations)

---

## 1. Opening and playing

1. Open the project launcher and go to **Examples ▸ Dungeon**, then press **Download**. The example
   (about 200 MB) is copied into a **new project**, so your other projects are untouched.
2. Wait for the scene to finish loading, then press **Play** (▶).
3. Click the game view to capture the mouse.

Everything you change in that project, whether art, tuning or bindings, is saved in that project like
any other. The example folder in the repository is only the starting point.

### Where things are in Assets

The Assets panel is grouped by **what a thing is in the game**, not by asset type. Each character,
weapon, prop and effect has a folder holding everything it is made of, in type subfolders (`Scripts/`,
`Materials/`, `Particles/`, `Animations/`, `AI/`, `Textures/`). A base and its variants sit side by side,
so what a variant adds stays apart from what it inherits:

```
Scenes/            Dungeon.scene
Core/Scripts/      shared modules: SoulsMath, SoulsHitbox, SoulsAudio, SoulsCharacter
Game/              Game Manager, and UI/ (HUD, Boss Bar, Banner, Bonfire Menu, Pause Menu)
Characters/
  Shared/          mannequin model, rig, locomotion field, controller, textures, shared clips
  Player/          Player template, its scripts, its sword/greatsword/roll/drink clips
  Enemies/
    Base Enemy/    Enemy + Enemy Spawn templates, the shared enemy scripts and brain
    Hollow/  Hollow Sorcerer/  Elite Knight/  Hollow Warden/
Weapons/           Base Weapon/ (Weapon template, SoulsWeapon, Weapon Move), then one folder per weapon
Props/             Bonfire/ Torch/ Fog Gate/ Lever & Gate/ Message/ Pickup/ Bloodstain/
Effects/           Blood/ Hit Spark/ Magic Bolt/ Slam Dust/
```

Sounds are not files: each template that makes a sound owns it as a SoundNode in its own `Sounds` group.

Scripts import each other by this path (`import { clamp } from '@/Core/Scripts/SoulsMath'`), so move a
shared script and you move its import lines with it. Everything else references by id and can be moved
freely.

## 2. Controls

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Move | W A S D | Left stick |
| Camera | Mouse (click the game to capture it) | Right stick |
| Light attack (combo) | Left mouse | RB |
| Heavy attack | Right mouse | RT |
| Roll; backstep with no direction (tap) | Space | B |
| Sprint (hold) | Space | B |
| Lock on / off | Q or middle mouse | R3 |
| Switch target | Z / C, or flick the mouse | D-pad left / right, or flick the right stick |
| Drink Estus | R | X |
| Swap weapon | F | D-pad up |
| Interact (bonfire, item, message, lever, fog) | E | A |
| Level-up menu: select / adjust / confirm / leave | Arrows or WASD / Enter / Esc | D-pad or stick / A / B |

The bindings are the project's **input map** (Input mode). The example ships it in
`libraries/inputMap.json`, and importing the example installs it. If a script logs *"the input map has no
LightAttack…"*, the map is missing; re-import the example or add the actions shown above.

## 3. What is in the level

The player starts in the entry hall, under the ladder to a shut hatch, and goes down through three levels to
the throne arena.

| Place | Contents |
|---|---|
| Entry hall | Player start, the bonfire, the welcome message, a hanging brazier, breakable barrels. |
| Cell corridor and cell room | Barred cells, two Hollows, the Jailer's souls. |
| East corridor and crypt | Candles for a warden of old, and a message about him. |
| Great hall | Two Hollows, the fireplace, the Hollow Sorcerer on the wooden gallery, souls; the south rooms below and above it, an Estus Shard upstairs. |
| Stair hall | The Elite Knight among the pillars, two fire pits, a warning message at the stair. |
| Guard room and catacombs | Down the stair: Hollows, a fire pit, the ossuary's souls. |
| Arena hall | The fog gate, the Hollow Warden in the round arena, its reward and the epilogue. |

The **game loop**:
- **Bonfire:** light it, then rest to heal, refill flasks and level up. Resting respawns every enemy
  except a defeated boss, and the bonfire becomes your respawn point.
- **Death:** your souls drop as a bloodstain where you fell. Touch it to recover them. Die again first
  and they are gone for good.
- **Boss:** walking through the fog gate wakes the Hollow Warden; below half health it roars and enters
  phase two, faster and with a leap slam and a bolt fan. Dying mid-fight resets the boss and the fog.

## 4. How the scripts fit together

All scripts live in `examples/scripts/Souls*.ts` and are installed in the project as Script assets.
Pure helpers (`num`, `yawTo`, `statBonus`, …) live in the **SoulsMath** script module, which the
others import with `import { yawTo } from './SoulsMath'`.

**Every node owns its own data.** The player owns its attributes, HP, stamina, flasks and the curves
between them; each enemy type owns its stats; each weapon owns its numbers, its hitbox, its moveset and
the maths that turns a swing into damage. Damage goes from the weapon straight to the target's
`receiveHit`, where the target applies its own defence. The GameManager owns no one's data: it is the
**world** — who is registered, where you respawn, what a death does, the boss fight, sounds and effects.

Shared behaviour is **inherited**, not copied: a base script holds what a family has in common, and each
member is a script that `extends` it and changes only what differs.

```
SoulsCharacter            hp, defence, team, receiveHit, weapons spawned from templates
├── SoulsPlayer           attributes, stamina, flasks, stat curves, the action state machine
└── SoulsEnemy            poise, spacing, attack choice, reactions, death
    ├── SoulsHollow             (only its stats)
    ├── SoulsHollowSorcerer     (only its stats)
    ├── SoulsEliteKnight        (only its stats)
    └── SoulsHollowWarden       its stats + its phase two

SoulsWeapon               stats, blade hitbox, moves, attackRating, strike
├── SoulsLongsword  ├── SoulsGreatsword  ├── SoulsClub  ├── SoulsStaff  └── SoulsHalberd
```

| Script | Node | Role |
|---|---|---|
| `SoulsGameManager` | `GameManager` | Registries of enemies, interactables and spawns, and which node is the boss.<br>Rest, death and respawn, bloodstains, the boss fight.<br>`sfx()`, `fx()`, `bleed()`, banners, notices. |
| `SoulsCharacter` | (base class) | HP, `defense`, `team`, the one `receiveHit` every attack goes through, and the weapons: spawned from the templates named in `weaponTemplates`, into the hand. |
| `SoulsPlayer` | `Player` (Character) | Attributes, stamina and Estus, and the curves `hpForVigor`, `staminaForEndurance`, `levelFor`, `levelCost`.<br>The action state machine (free, attack, roll, backstep, drink, swap, hit, rest, fog, dead) with input buffering.<br>Interact prompt. |
| `SoulsLockOn` | `Player/camera rig` | Orbit camera plus target lock (`rankLockTargets`), switching and the reticle. |
| `SoulsWeapon` + one subclass per weapon | each **weapon template**'s root | The weapon's stats (its subclass's defaults), blade hitbox, `attackRating`, `strike`. |
| `SoulsMove` | weapon template children | One player attack per node: its clip, timing, stamina and damage multiplier. |
| `SoulsEnemy` + one subclass per type | each **enemy template**'s root | Poise, flinch and stagger, spacing and strafing, attack choice (`pickAttack`), death. The type's stats are its subclass's defaults; the Warden's subclass adds its phase two. |
| `SoulsEnemyAttack` | `<enemy>/Attacks/*` | One enemy attack per node. |
| `SoulsEnemyBrain` | `<enemy>/Brain` (last child) | Player-only targeting (the engine has no factions) and the enemy's home point. Every decision is the type's AI graph — see below. |
| `SoulsEnemySpawn` | `Enemy Spawns/*` (template `Enemy Spawn`) | Instantiates the template picked from its `spawnables`, and re-creates it on rest or death. |
| `SoulsProjectile` | `Magic Bolt` template | Swept-sphere flight against hurtboxes, plus a ray against the world; a roll's i-frames let you pass through. |
| `SoulsHitbox` | script module | Blade hitboxes, hurtboxes and swing blockers, shared by the player, the enemies and the bolt. See **Combat** below. |
| `SoulsFx` | effect templates | Bursts its particles, fades its lights, then removes itself. |
| `SoulsBonfire`, `SoulsPickup`, `SoulsBloodstain`, `SoulsMessage`, `SoulsLever`, `SoulsDoor`, `SoulsFogGate` | interactables | Each one follows the **interactable protocol** below. |
| `SoulsHud`, `SoulsBonfireMenu` | `Player/HUD`, `Player/BonfireMenu` | The player's HUD and level-up menu — children of the player, reading the player. |
| `SoulsPauseMenu` | `Player/PauseMenu` | The pause menu (P, Escape, Start): `Game.pause()`, Resume and Return to Bonfire. Listens in a late update, which runs while paused. |
| `SoulsBossBar` | `Hollow Warden/BossBar` | The boss's health bar — a child of the boss, shown while its owner is awake and alive. |
| `SoulsBanner` | `GameManager/Banner` | The big banners (YOU DIED, BONFIRE LIT, VICTORY) — the game flow's. |

**Interactable protocol.** An interactable carries a **trigger volume** (its interaction zone, set in
the node's **Physics** section like a collider) and exposes these members:
- `canInteract(player)`
- `promptText(player)`
- `interact(player)`

Walking into the zone makes it a candidate (the player's `onTriggerEnter`); walking out removes it
(`onTriggerExit`). The player prompts for the nearest candidate whose `canInteract` passes. No distance is
measured in script, so to make the prompt appear from further away, **resize the trigger**. The build
uses a cylinder whose radius is the reach minus the player's 0.3 m capsule radius; the door and the fog
gate use a box spanning both sides of the wall, and their `canInteract` picks the side. To make a new
kind, copy `SoulsMessage.ts` and give the node a trigger.

The `Boss Arena` node (under `Interactables`) is a zone too: a trigger box with the `isBossArena`
variable. Entering it starts the boss fight even if the player got in without walking through the fog.

**Combat.** Hits are decided by shapes, not distances (`SoulsHitbox`):
- **Hurtboxes** are the characters' own capsule colliders. A character whose `hurtboxActive` is false is
  invisible to every attack. That is what i-frames are: during a roll, backstep, fog walk, rest or death
  the player's hurtbox is off, and during its phase-two roar the boss's is. Which hurtboxes an attack
  sees is decided by `team`: the player's blade hits `enemy`, an enemy's hits `player`.
- **Hitboxes** are capsules along the weapon blades: `bladeStart`, `bladeEnd` and `bladeRadius`, in the
  weapon's `Mesh` space — fields of the weapon's own script, so a subclass sets its blade.
- **Damage.** A player hit is the weapon's `strike`: its attack rating for the player's STR/DEX × the
  move's `damageMul`. An enemy hit is the attack's own `damage` (an enemy's moveset is tuned per move).
  Either way the target takes it through its `receiveHit`, minus its own `defense`.
- **Active window.** From a clip's `hit` event to its `hitEnd` event, the blade is swept every frame from
  where it was last frame to where it is now, so a fast swing cannot pass through a target between
  frames. Each target is hit once per swing, at the point the blade touched it.
- **Swing blockers.** Walls, pillars and the gates carry the variable `blocksSwings`. A player swing whose
  blade reaches one before any enemy bounces off it: sparks (the only place they show), a recoil (`recoilSeconds`, `recoilClip`), no
  damage. Heavies (`bounceOff: false` on the move) plough through. Floors never block. Enemy attacks
  ignore blockers unless the attack sets `bounceOff`.
- **Slams** (`aoeRadius`) hit every hurtbox inside the radius at the `hit` event.

**Editing behaviour.** Every number in the tables below is a **public field**, so it appears in the
node's **Scripts** section in the inspector. A field edited on a node overrides the code default. Fields
on nodes inside a template are edited in **Template mode**: open the `.tpl` from Assets.

### Weapon and enemy templates: variants

Every weapon is its own template, in `Assets ▸ Templates ▸ Weapons`, and every enemy type in
`… ▸ Enemies`. Each is a **variant** of a base template (`Weapon`, `Enemy`): it inherits the base's
nodes and records only what it changes. Edit the base and every variant follows, except where a variant
changed that value itself.

| Base | Variants | What a variant changes |
|---|---|---|
| `Weapons/Weapon` (root + empty `Mesh`) | `Longsword`, `Greatsword`, `Club`, `Sorcerer Staff`, `Halberd` | its script (`SoulsLongsword` …), the grip and parts inside `Mesh`, its moves (`Light1` … `Heavy`) |
| `Enemies/Enemy` (mannequin, anchors, empty `Weapons`, `Attacks`, health bar, brain) | `Hollow`, `Hollow Sorcerer`, `Elite Knight`, `Hollow Warden` | its script (`SoulsHollow` …), size and tint, anchors, sight, its attacks; the Warden drops the health bar and adds `PhaseAura` |

**When an enemy dies it drops its weapon**: the weapon leaves the hand for the world and becomes a physics
body (spheres along its blade), so it falls and can be kicked about, until the corpse is removed, which
takes the weapon with it. `dropWeaponOnDeath` and `droppedWeaponMass` on the enemy; `dropWeapon()` on any
fighter does it on demand.

Characters do not hold their weapons in their own template. Each names them in `weaponTemplates`
(`Longsword, Greatsword` on the player, `Club` on the Hollow) and **spawns them on start** into its
`Weapons` group, attached to the right hand. The Elite Knight wields the very `Greatsword` template the
player does: change it once, both get it. While authoring, the hands are therefore empty; press Play to
see the weapons held.

### Templates and placed copies

Everything placed more than once, or replaced as one piece of art, is a **template**, and the scene
holds **linked copies** of it:

| Template (`Assets ▸ Templates`) | Copies in the scene |
|---|---|
| `Level/Player` | `Player` |
| `Level/Torch` | the 19 torches under `Torches` |
| `Level/Bonfire` | `Interactables/Bonfire` |
| `Level/Lever`, `Level/Gate` | none placed: the shortcut pair ships for a level of your own |
| `Level/Fog Gate` | `Interactables/Fog Gate` |
| `Interactables/Message` | the 7 `Message: …` nodes and `Epilogue Message` |
| `Interactables/Pickup` | `Souls Pickup`, `Estus Shard`, `Hall Souls`, `Boss Reward` |
| `Enemies/Enemy Spawn` | the 8 nodes under `Enemy Spawns` (see below) |
| `Enemies/*` | none placed: the **Enemy Spawns** instantiate them at runtime, and again on every rest |
| `Weapons/*` | none placed: each character spawns the weapons it names, at runtime |

**Enemy spawns pick from a list.** The `Enemy Spawn` template's script declares
`spawnables: string[]`, the templates a spawn may make. Each placed spawn picks its `templateName`
from that list in a dropdown in the inspector, because the field carries an `@options spawnables` tag.
Edit the list once, in the template, to offer a new enemy type to every spawn.

**Change the art once, in the template.** Double-click it in Assets, edit, save: every copy updates
and keeps its own position. Inside a copy, the scene only shows one row; its children belong to the
template and cannot be moved, deleted or renamed in the Scene panel.

**What each copy keeps of its own (overrides).** A copy's **Transform**, its **name**, and the **values
of its script fields**, on the copy's root or on any node inside it, are the copy's own. Edit them on
the copy in the inspector: an overridden value shows a **revert** marker, which puts the template's
value back, and **Revert all** in the yellow template banner drops them all. Everything else (children,
meshes, materials, colliders, which script is attached) comes from the template. In this scene:
- each message overrides its `title` and `text` (and its name);
- each pickup overrides what it gives: `kind`, `amount` and `itemName` (and its name);
- `Boss Reward` and `Epilogue Message` also override `hiddenUntilRevealed`;
- a placed `Lever` and `Gate` override only their names, which is how the lever finds its door
  (`doorName`) and how the scripts find both.

Scripts look nodes up **by name** (`Player`, `Boss Reward`, `Epilogue Message`, a lever's door, the
`Fire` inside a bonfire), so keep those names when you rename or replace things.

## 5. The asset manifest

Conventions for **all final art**:
- **Units:** metres. **Up:** +Y. **Forward:** +Z, so characters face +Z in their bind pose.
- **Characters** are humanoid and Mixamo-compatible, or anything the retargeter can map. They are about
  1.8 m tall, with the boss at about 3.2 m.
- **Clips are in place**, except where an Actions state extracts the travel for the script (the roll,
  the Longsword's steps; see §6).
- **Weapons:** the grip sits at the origin and the blade or shaft runs along local **+Y**.

### Characters

| Placeholder | Where | Replace with | Notes |
|---|---|---|---|
| Mannequin, untinted | Template **Player**: `Player/Ch36` | The player character | Keep the `Weapons` group and `Player Controller` as they are. The capsule is on `Player` (r 0.3, h 1.78). |
| Mannequin, grey-green (`Hollow (placeholder)` material) | Template **Hollow**: `Hollow/Ch36` | Basic undead soldier | Wields the **Club** template. |
| Mannequin, blue (`Caster (placeholder)`) | Template **Hollow Sorcerer** | Robed caster | Wields the **Sorcerer Staff** template. Bolts leave from the **LeftHand** socket. |
| Mannequin ×1.2, red (`Elite Knight (placeholder)`) | Template **Elite Knight** | Armoured knight | Wields the **Greatsword** template. |
| Mannequin ×1.8, dark metal (`Hollow Warden (placeholder)`) | Template **Hollow Warden** | The boss | Wields the **Halberd** template. Capsule r 0.45, h 3.2. |

All four are variants of the **Enemy** template, so a model replaced there (`Enemy/Ch36`) reaches every
type that has not changed it.

Each enemy template also holds a **LockPoint** (chest height, where the lock-on aims) and a
**HealthAnchor** (above the head, where the floating health bar sits). When you swap in a
taller or shorter model, move these two nodes to match.

**Hands.** Weapons ride the model's `RightHand` socket, and spells leave from `LeftHand`. Any humanoid
rig has both without authoring: bones the engine reads as hands (`mixamorig:RightHand`, `hand_r`,
`hand.R`, `RightHand`…) answer to those names automatically. If the sword sits at an odd angle in your
model's hand, open its rig, select the hand bone, **+ Socket** (it is named `RightHand` for you) and give
it a rotation/offset — an authored socket overrides the automatic one. A model whose bones are not
recognisable as a humanoid has no hands: the console says so (`… has no "RightHand" socket`), the
weapon stays where it is, and its swings hit nothing until you add the socket.

### Weapons

| Placeholder | Where | Replace with |
|---|---|---|
| A built blade, crossguard, grip and pommel | Template **Longsword**: `Mesh` | Two-handed sword mesh (the right hand at the guard, the left 11 cm below) |
| Three boxes | Template **Greatsword**: `Mesh` | Greatsword mesh (the player's and the Elite Knight's) |
| A cylinder | Template **Club**: `Mesh` | The Hollows' club |
| A cylinder and an orb | Template **Sorcerer Staff**: `Mesh` | The sorcerer's staff |
| A shaft and a head | Template **Halberd**: `Mesh` | The Warden's halberd |

### Level and props

| Placeholder | Where | Replace with |
|---|---|---|
| ~60 boxes and cylinders with colliders | Scene: `Level/*` | Your level art. Keep, or rebuild, **colliders** where people walk: the bake and the characters use colliders, not meshes. |
| Torch posts with a fire particle and a point light | Template **Torch** (19 copies under `Torches`) | Torch props. One edit to the template changes every torch. |
| Ash disc, stones and a sword (`Bonfire/Model`) | Template **Bonfire**: `Bonfire/Model` | The bonfire. Keep `Fire`, `Fire Light` and `RespawnPoint`; the respawn point is where, and facing where, you stand up. |
| Iron box (`Gate/Bars`) | Template **Gate** (not placed) | Portcullis or door. The collider is on the template root (3.2 × 4 × 0.4), and it slides by `openOffset`. |
| Stone block and bar (`Lever/Base`, `Handle/Stick`) | Template **Lever** (not placed) | The lever. `Handle` swings about its X axis. |
| Translucent sheet (`Fog Gate/FogWall`) plus `Fog` particles | Template **Fog Gate** | The fog wall. The collider is on the template root (6 × 4 × 0.5), and local +Z points into the arena. |
| Orange glyph (`Message/Glyph`) | Template **Message** (7 copies + `Epilogue Message`) | Message sigil |
| Glowing sphere (`Pickup/Item`) | Template **Pickup** (4 copies) | Item or corpse prop |
| Glowing splat decal (`Bloodstain/Pool`) | Template **Bloodstain** | Bloodstain decal: change the `Bloodstain Decal (placeholder)` material's texture, or replace `Pool` with a prop |
| Blood spatter decal | Template **Blood Drops** (`Decal` child) | Your blood decal: change the texture on `Blood Drops (placeholder)` (§9) |
| Blue sphere (`Magic Bolt/Core`) | Template **Magic Bolt** | Projectile visual |

### Materials

The character materials keep the mannequin's textures with a colour tint. Prop materials are flat
colours. All of them are under `Assets ▸ Materials` with **(placeholder)** in the name. Edit them in
place, or assign your own (§11.6).

## 6. Animation contract

### State machine on every character model

The base layer of every character's machine is the same:

| States | Parameters | Transitions |
|---|---|---|
| **Idle** (entry, loop)<br>**Locomotion** (blend space `Souls Locomotion`: Direction × Speed)<br>**Dead** (clip `Souls_Death`, no loop) | `Speed` → built-in `planarSpeed`<br>`Direction` → `planarAngle`<br>`Died` trigger<br>`Revive` trigger | Idle ⇄ Locomotion on Speed 0.5<br>Idle / Locomotion → Dead on `Died`<br>Dead → Idle on `Revive` |

If you build a new machine for a new model, keep the two trigger names. The scripts fire `Died` and
`Revive` by name.

There are six controllers on the `Mannequin` rig:
- **Souls Character** (the player) falls with `Souls_Dying`.
- **Souls Enemy** (the base Enemy template) and one per type — **Souls Hollow**, **Souls Hollow
  Sorcerer**, **Souls Elite Knight**, **Souls Hollow Warden** — fall with `Souls_Death` (Standing Death
  Right), then go limp after `deathSeconds`. They differ in their Actions layer: each type's own attacks.

**Upper body: running with the sword.** Every machine carries an `UpperBody` layer:
- It is an override layer with the **Weapon Arm** bone mask: the right shoulder and everything below it.
  The torso, the head and the left arm keep the locomotion's own swing.
- Its two states are `Off`, an empty state that contributes nothing, and `Sword Run` (`Souls_RunWithSword`, looping).
- It switches on above `Speed` 2.2 and off below 1.8. While running, the arm carries the blade the way a
  fighter runs with one, and the legs keep the locomotion blend's footwork.
- Walking and strafing keep the guard pose.

**One-shots: the Actions layer.** Every attack, roll, hit reaction and gesture is a state of an
`Actions` layer — full body, on top of every other layer, resting in an empty `Off` — entered directly
by its trigger (**Enter on trigger**) when the scripts fire it by name (the `*Trigger` fields; a move's
or attack's `animTrigger`). The scripts play no clip and name no state: the graph holds each one-shot's
clip, speed, start and blends, and SoulsCharacter asks the animator how long what a trigger plays lasts
(`triggerInfo`) and whether it still plays (`activeTrigger`). The Actions graphs hold no Any State edge.
- Each one-shot leaves for `Off` as its clip ends, starting its blend-out (0.22 s; 0.35 s for an attack)
  so the fade finishes with the clip.
- `Off` is entered from anywhere by its own triggers — `Died` (the base falls on the same trigger), `Stop`
  (with a blend: standing up from a bonfire) and `Cut` (at once: a run turn called off after the body
  turned) — and is first in the list, so they win a frame in which a one-shot is fired too.
- **Roll** plays `Souls_Roll` at 1.5x, with no foot placement, and **extracts its root travel**: the dive's
  own travel goes to `SoulsPlayer`, which moves the body by it through its own collision.
- **RunTurnRight** / **RunTurnLeft** play the running 180° turn (`Souls_RunTurn180` and its mirror) at 1.2x
  with no foot placement, and leave with no blend at the clip's very end: on that same frame `SoulsPlayer`
  turns the node round, so the run carries on facing the new way.
- **Sheath** (on the `Swap` trigger) hands over to **Draw** at its end; the weapon changes on the sheathe
  clip's `swap` event. **Rest** loops until `Stop`.
- The player's weapon moves are states named `<Weapon> <Move>`. The Longsword's light combo is one clip
  in three segments: **Longsword Light2** and **Light3** start part-way into `Souls_LS_Combo` and are
  entered only from the segment before, on their own trigger, at its end.
- An enemy type's attacks are states named after the attack. They play at their speed times the
  `AttackSpeed` parameter, which the Warden raises in its second phase. `Flinch`, `Stagger` and — on
  the boss — `Taunt` and `Roar` are its reactions.

**The player in a fight.** The player's machine adds a bool parameter, `InCombat`, which `SoulsPlayer` sets
while it is locked on, while any enemy is engaged with it (`SoulsEnemy.engagedWith`), and for
`combatLinger` seconds (5) after it lands or takes a blow:
- **CombatIdle** (`Souls_LS_Stance`, looping) replaces Idle: the Longsword's guard, both hands on the hilt.
  Idle ⇄ CombatIdle trade on the flag; Locomotion stops into whichever one the flag calls for.
- A **Guard** layer on the **Arms** mask (both shoulders and below) plays `Souls_LS_Guard` while moving in
  a fight, so the hands stay on the hilt over the legs' footwork. At a sprint (Speed above 4.7) it gives way
  to the sword run.

### Clips the player uses

**The combat clips are Mixamo downloads.** These come from `build/animations/`:
- the straight sword and greatsword movesets, the roll (Standing Dive Forward), the heavy hit reaction and the
  player death;
- sheathe and draw;
- the enemy swings, the knight's two combos and the warden's leap;
- the battle cry, the enemy death, and the sword run.

`tools/soulsDemo/importClips.mjs` retargets them onto the mannequin, holds them in place and writes
`tools/soulsDemo/soulsClips.json`, which is committed. Each clip takes the name of the placeholder it
replaces, and the generator drops that placeholder.

Their `hit` / `hitEnd` / `combo` / `recover` markers are measured from the right hand's speed: each
swing's fastest moment gets a short window around it. Pin any time the measurement gets wrong in
`MARKER_OVERRIDES`.

The downloads are slow next to a souls swing, so the moves play them faster with `playSpeed` 1.15–1.6.
The generator derives the moves' fallback timings, their `lungeStart` and their tracking from the markers.

**The Longsword's clips are made in the Motion Creator.** They are the documents in
`tools/soulsDemo/longsword/*.motion.json`. Open one in Cleo Creator ▸ Motion ▸ **Open…**, edit it,
**Download**, and put the `.motion.json` back. Then run:

```
npx vite-node --config applications/creator/vitest.config.ts tools/soulsDemo/longsword.ts bake
```

This bakes them with the Creator's own baker into `tools/soulsDemo/longswordClips.json`. `longsword.ts author`
rewrites the documents from the choreography in that file, overwriting edits made in the Creator.

**The light combo is one clip.** `Souls_LS_Combo` holds all three attacks back to back:
- each ends on a `next` event;
- each `Light` move's Actions state plays its segment, starting where the one before ends;
- one press plays the first attack and blends back to the guard; pressing again during the swing fires
  the next attack's trigger, and the layer plays on into it at the segment's end without restarting anything.

The attacks **step**. The feet move and the hips travel, and the moves' states extract the root travel,
so the body moves exactly as far as the feet do. There is no lunge.

The **States** column names the Actions-layer state that plays a clip (§6), and the trigger of the same
name enters it — what a script's `*Trigger` field or a move's `animTrigger` fires.

| Clip (placeholder name) | Length | Required events | States |
|---|---|---|---|
| `Souls_LS_Combo` | 3.1 s (three segments) | per attack: `hit`, `hitEnd, combo`, `recover`, then `next` | `Longsword Light1..3` |
| `Souls_LS_Heavy` | 1.8 s | `hit`, `hitEnd`, `combo`, `recover` | `Longsword Heavy` |
| `Souls_LS_Stance` / `Souls_LS_Guard` | 2.4 / 1.8 s, loop | — | the player's `CombatIdle` state / `Guard` layer |
| `Souls_Sword_L1` / `L2` / `L3`, `Souls_Sword_Heavy` | 0.9–1.4 s | `hit`, `combo`, `recover` | unused since the Longsword replaced the Straight Sword; kept in the library |
| `Souls_GS_L1` / `L2` | 1.4 s | `hit`, `combo`, `recover` | `Greatsword Light1..2` (and the Knight's `Sweep`) |
| `Souls_GS_Heavy` | 2.0 s | `hit`, `recover` | `Greatsword Heavy` |
| `Souls_Roll` | 1.6 s, played at 1.5x | — | `Roll` (extracts its travel) |
| `Souls_RunTurn180` / `Souls_RunTurn180L` | 0.67 s, played at 1.2x | — | `RunTurnRight` / `RunTurnLeft` (the second is a mirror edit of the first) |
| `Souls_Backstep` | 0.45 s | — | `Backstep` |
| `Souls_Drink` | 1.4 s | `drink` (when the heal starts) | `Drink` |
| `Souls_HitLight` / `Souls_HitHeavy` | 0.45 / 0.9 s | — | `HitLight` / `HitHeavy`, `Recoil` (HitLight at 1.4x); the enemies' `Flinch` / `Stagger` |
| `Souls_Sheath` / `Souls_Draw` | 1.7 / 1.5 s (played at 2x) | `swap` (sheathe's end) | `Sheath` → `Draw`: a swap sheathes, changes weapon, then draws |
| `Souls_Swap` | 0.4 s | — | placeholder, no longer used |
| `Souls_Rest` | 1.2 s, loops | — | `Rest` (sitting at the bonfire) |
| `Souls_Interact` / `Souls_Pickup` | 0.9 / 0.8 s | — | `Interact` (lever, bonfire lighting) / `Pickup` (pickups, bloodstain) |
| `Souls_FogWalk` | 1.5 s | — | `FogWalk` |
| `Souls_Death` | 2.3 s, root motion | — | the enemies' `Dead` state (then the ragdoll) |
| `Idle`, `Walk`, `Run`, strafes, backwards, diagonals | — | — | the `Souls Locomotion` blend space |

### Clips the enemies use

Each attack below is a state of its enemy type's Actions layer, named after the attack.

| Clip | Length | Required event | Attacks |
|---|---|---|---|
| `Souls_Enemy_Swing` | 1.2 s | `hit`, `hitEnd` | Hollow `Swing`, Sorcerer `Shove` |
| `Souls_Enemy_Sweep` | 1.3 s | `hit`, `hitEnd` | Hollow `Sweep` (and the source of the Tall/Giant variants) |
| `Souls_Tall_Sweep` | 1.3 s | `hit`, `hitEnd` | Knight `Sweep` |
| `Souls_Giant_Sweep` / `Souls_Giant_Backsweep` | 1.3 / 1.4 s | `hit`, `hitEnd` | Warden `Sweep` / `Backsweep` |
| `Souls_Enemy_Overhead` | 1.7 s | `hit`, `hitEnd` | Knight `Overhead`, Warden `Slam` |
| `Souls_Enemy_Thrust` | 1.2 s | `hit`, `hitEnd` | Knight `Thrust` |
| `Souls_Giant_Thrust` | 1.2 s | `hit`, `hitEnd` | Warden `Lunge` |
| `Souls_Cast` | 1.2 s | `cast` (the bolt leaves) | Sorcerer `Bolt`, Warden `Bolt Fan` |
| `Souls_Leap` | 1.8 s | `hit` (landing) | Warden `Leap` |
| `Souls_Knight_Combo1` / `Combo2` | 4.7 / 4.2 s | several `hit` / `hitEnd` pairs | Knight `Combo` / `Flurry`: each pair is a fresh damage window |
| `Souls_Battlecry` | 2.8 s | — | the boss's `Taunt`, played once on first sight (regular enemies never taunt); the Warden's `Roar` (phase two) |
| `Souls_Dying` | 2.6 s, root motion | — | the player's `Dead` state |
| `Souls_Roar` | 2.0 s | — | placeholder, no longer used |

### What the events mean

| Event | Meaning |
|---|---|
| `hit` | The blade becomes ACTIVE: from here it is swept every frame against enemy (or player) hurtboxes. For a slam, the moment of impact. |
| `hitEnd` | The blade stops being active. Each target is hit at most once between `hit` and `hitEnd`. |
| `combo` | From here, a buffered attack chains into the move named in `next`. |
| `recover` | From here, a buffered roll or drink may cancel the rest of the swing. |
| `drink` | The flask is consumed and the heal begins. |
| `cast` | Projectiles spawn at the cast socket. |

**No events yet?** A clip without a `hit` event still works. The move's `hitTime` + `activeSeconds`,
`comboTime` and `recoverTime` fields (clip seconds) are used instead. Import first, add markers later.

**The placeholder windows** run from halfway through the swing into the striking key to halfway through
the follow-through after it (`placeholderClips.mjs`). The 1.2x knight and the 1.8x Warden swing
`Souls_Tall_Sweep`, `Souls_Giant_Sweep`, `Souls_Giant_Backsweep` and `Souls_Giant_Thrust`: the same
motions, crouched with the arms dropped, because a man-sized swing scaled up passes over the player's
head — and now a swing over the head misses.

**In place.** An Actions state moves nothing by itself, so travel is the script's: a lunge from
`lungeStart`, `lungeSeconds` and `lungeSpeed` on moves and attacks, or — for a state that extracts its root
travel (the roll, the Longsword's steps) — the clip's own travel, handed to the script through
`consumeRootMotion`. Bake root motion out of other clips on export, or leave their **Root motion** toggle off.

## 7. Sockets and weapon grips

The `Mannequin` rig has two sockets: **RightHand** (`mixamorig1:RightHand`) and **LeftHand**. Weapons
attach with **Attach to socket ▸ Nearest character above ▸ RightHand**. A new rig needs the same two
socket names; see §11.4.

While attached, the weapon node's transform is driven every frame. **Adjust the grip on its `Mesh` child**,
whose position and rotation are relative to the hand. The generator computed the placeholder grips
so the blade points forward and down at idle. Socket scale ignores the bone's scale, which is why each
enemy's weapon is sized in its `Mesh` child rather than inherited from the scaled body.

## 8. Sound cues

Every sound is **owned by the thing that makes it**. Each template that plays audio has a `Sounds` group
in its own tree, holding one **empty Sound node** per cue. Assign a sample to each one, in the template,
to hear it. A node with no sample is silent, and nothing breaks.

A script plays a cue by name with `playSound(this, 'Lever')` from the `SoulsAudio` module. The call
walks up from the playing node to the nearest ancestor that has a `Sounds` group. So the bonfire menu
and the lock-on camera play the Player's cues, and an enemy's attacks play the enemy's. A bolt that is
about to vanish uses `playDetached`, which moves the cue to the scene root so the sound isn't cut off.

World objects are **Spatial**, so you hear them from where they are. The player's cues and the game
flow's cues are **Ambient**.

| Owner (template, or scene node) | Cue | Played when |
|---|---|---|
| `Player` | `Swing`, `Swing Heavy` | the player starts a light or heavy attack |
| | `Roll` | roll or backstep |
| | `Drink` | an Estus flask is consumed |
| | `Player Hurt` | the player takes damage |
| | `Souls` | souls gained |
| | `Recoil` | a swing bounces off a wall |
| | `Lock On` | a target is locked |
| | `Level Up`, `Menu Tick`, `Menu Deny` | level-up confirmed; a point is adjusted; not enough souls |
| `Weapon` (every weapon variant) | `Hit` | the weapon connects (its `hitSound` field) |
| `Enemy` (every enemy variant) | `Enemy Swing` | an attack starts (each attack's `sound` field can name another cue) |
| | `Player Hit` | an enemy swing connects (impact) |
| | `Stagger` | the enemy's poise breaks |
| | `Enemy Death` | the enemy dies |
| | `Cast` | a projectile is fired |
| `Hollow Warden` (adds) | `Boss Leap`, `Boss Roar` | the leap attack; phase two |
| `Magic Bolt` | `Bolt Impact` | the bolt hits |
| `Pickup` | `Pickup` | an item is picked up |
| `Lever` / `Gate` / `Fog Gate` | `Lever` / `Door` / `Fog` | pulled / opens / walked through |
| `GameManager` (scene node) | `Bonfire Lit`, `Rest`, `Death`, `Victory` | a bonfire is lit; sitting; YOU DIED; the boss is defeated |
| | `Ambience` | loops from the start; stopped during the boss fight |
| | `Boss Music` | loops during the boss fight |

An enemy variant inherits the base `Enemy` cues. A new cue an attack names (`sound`) must be added to
that variant's `Sounds`.

## 9. Visual effects

All effects are `.vfx` assets under `Assets ▸ Effects`, embedded in Particle System nodes.

| Effect | Used by |
|---|---|
| Bonfire Fire | `Bonfire/Fire` (plays once the bonfire is lit) |
| Torch Fire | `Torches/*/Fire` |
| Fog Wall | `Fog Gate/Fog` |
| Magic Bolt Trail | template `Magic Bolt/Trail` |
| Magic Bolt Impact | template `Bolt Impact` |
| Hit Spark | template `Hit Spark` (where a blade meets a wall and bounces off; a body bleeds instead) |
| Slam Dust | template `Slam Dust` (boss slam and leap) |
| Item Glow, Message Glow | pickups and messages |
| Bloodstain Glow | template `Bloodstain` |
| Phase Two Aura | `Hollow Warden/PhaseAura` (starts at phase two) |
| Blood Spray | template `Blood Spray` (droplets thrown off every landed hit) |

The effect templates carry `SoulsFx` with a `lifetime` field. Make it at least as long as the effect.

The torches, the bonfire and the boss aura carry distance **LOD** (particle editor ▸ LOD): a torch
spawns half as much past 15 m and a quarter past 30 m, simulating less often, and is not drawn past
70 m; the bonfire's embers drop out past 20 m. With 19 torches along the keep, most are thinned or
culled at any moment.

To give the torches a sprite flame, open the **Torch** template, add an Animated Sprite on the fire
tileset (Constraints: Cylindrical, so it faces the camera upright), and set that tileset's **Overdrive** to about 3–4 in tileset mode so
the flame blooms. All 19 placed torches follow the template.

Hit sparks, the magic bolt's impact and blood spray collide with the **physics bodies** around them
(their Collision module, **Physics bodies** on): sparks ricochet off the floor, the bolt's motes skitter
across it, and blood lands and stays.

### Blood

Every hit that lands, on an enemy or on the player (`SoulsCharacter.receiveHit`, melee and bolts alike),
calls `GameManager.bleed`, which spawns two things. A blade that meets a body throws no sparks: those are
for a blade meeting a wall (`SoulsWeapon.hitSparkTemplate`).

| Template | What it is |
|---|---|
| `Blood Spray` | Blood thrown off the wound (`SoulsFx`), spawned where the hit struck -- the blade's contact point, the bolt's, or chest height for a slam -- and scaled with the hit. |
| `Blood Drops` | A spatter **decal** a step further along the blow, pointed away from the attacker. |

A hit leaves no pool of blood: the pool is the **Bloodstain**'s, dropped where the player dies (with or
without souls in it; with none, its glow hides and there is nothing to retrieve), so it marks the last
place they died. The Bloodstain's decal children play their flipbook when it appears.

The decal template carries `SoulsBloodSplat`. On its first frame it raycasts down to find the floor
(it removes itself when there is none within `snapDown`), moves onto it, tilts to match a ramp (turning
its decals about the slope's normal, so the spatter still runs along the blow), picks a random size
between `minSize` and `maxSize` times the hit's size, and after `lifetime` seconds fades out over
`fadeSeconds` and is removed. A decal with a **flipbook** plays it from that moment, `flipbookStart`
seconds in (0: from its first frame; skip the frames where the liquid is still in the air when no spray
covers them): the Dungeon's are the FX Creator's liquid decals, the blood landing and spreading into a
pool. The splat scales with damage:
`bloodReferenceDamage` (120) is a full-size splat, from 0.6× to 1.6×, and the spray the same. The spray
is spawned turned along the blow, so its droplets fly on away from the attacker. `receiveHit(damage,
poise, from, point)` carries the contact point from the weapon (`SoulsWeapon.strike`), an enemy's blade
and a bolt to `bleed`.

**GameManager fields:** `bloodEnabled` (off: no blood at all), `bloodSprayTemplate` (empty: no spray,
the decal alone), `bloodDropsTemplate`, `bloodDropsOffset` (0.9 m: how far along the blow the
spatter's centre lies), `maxBloodDecals` (24; the oldest is removed first, so a long fight never piles up
decals), `bloodReferenceDamage`.

**The Dungeon's blood** is the FX Creator's liquid simulations (`tools/valley/creatorFx.mjs`), flipbooks
only, no particles. `Blood Spray` is the Blood Burst bake on a **lit** animated sprite: its Surface maps
(the albedo atlas, a normal and an ORM map) are its tileset's, so the scene's light shades the wet blood
-- dark in the dungeon, glossy under a torch -- and it plays once at the contact point (0.8 m across at
`bloodReferenceDamage`). `Blood Drops` is the Blood Spatter bake's floor decal at three quarters of the
bake's size (about 1.0 × 0.9 m), its GameManagers' `bloodDropsOffset` scaled with it (0.675 m), starting
from the frame before the blood reaches the floor (its `flipbookStart`, read from the atlas by the
build). The `Bloodstain`'s pool is the Blood Pool bake's. Each decal is an animated colour, normal and ORM
atlas (wet and glossy) with its flipbook. Open the same presets in the Creator's FX mode (Medium: Liquid)
to make your own.

**Swapping the art.** The splat images are generated placeholders (`tools/soulsDemo/png.mjs`) on the
`Blood Drops (placeholder)` material under `Assets ▸ Materials ▸ Effects`.
Assign your own texture as the material's base colour: RGB is the colour (multiplied by the base
colour), **alpha is the coverage**. A decal shows its texture once, so leave a transparent margin and
use clamp wrapping. The `Blood Drops` image is projected with its **top pointing along the blow**.

**What a decal lands on.** Decals paint deferred PBR surfaces: every material in this demo. They skip
Blinn-Phong, Cel, forward custom materials and transparent surfaces, and the whole route is off when the
renderer runs forward (`graphics.deferred: false`). The decal box is shallow (0.4 m) so a body standing in
the pool only gets its boots painted.

See [SOULS_FEATURE_MATRIX.md](SOULS_FEATURE_MATRIX.md) for which engine features and which souls-like
features this demo uses, and what is missing.

## 10. UI widgets

**Every UI belongs to the entity it shows**, and lives inside that entity's template: none sits loose at
the scene root. The player's HUD, level-up menu and lock-on reticle are children of the **Player**; each
enemy carries its own bar (a floating `HealthBar`, or the boss's on-screen `BossBar`); the banners belong
to the **GameManager**, whose game flow raises them. A UI script reads its OWNER (the nearest fighter
above it), so a second player, or a second boss, simply brings its own.

The UI scripts find widgets **by name**, so you can restyle, move or rebuild anything as long as the names
stay. A missing widget is simply skipped.

| Root (owner) | Widgets |
|---|---|
| `Player/HUD` | **Bars:** `Health`, `HealthLag` (the yellow drain), `HealthBack`, `Stamina`, `StaminaBack`. Bars grow with max HP and stamina (`pxPerHp`, `pxPerStamina`).<br>**Text:** `Estus`, `Weapon`, `Souls`, `SoulsGain`, `Notice`.<br>**Prompt:** `Prompt` panel holding `PromptText`.<br>**Message panel:** `Message`, `MessageTitle`, `MessageBody`.<br>**Help:** `Controls` (static). |
| `Player/BonfireMenu` | `Title`, `LevelText`, `SoulsText`, `CostText`, `Derived`, `Help`.<br>`Row_Vigor` / `Row_Endurance` / `Row_Strength` / `Row_Dexterity`, each containing `Label`, `Minus`, `Value` and `Plus`.<br>`Confirm`, `Leave`. |
| `Player/PauseMenu` | `Title`, `Resume`, `Bonfire`, `Hint`. |
| `Player/LockReticle` | A world-space root with a `Dot`. Any widget works; it follows the target's `LockPoint`. |
| `Hollow Warden/BossBar` | `Bar` group holding `BossName`, `BossHealth`, `BossLag`. Edit it in the **Hollow Warden** template. |
| `<enemy>/HealthBar` | A world-space root with a `Fill` progress bar that follows `HealthAnchor`. In the base **Enemy** template. |
| `GameManager/Banner` | `Band`, `BannerText` (YOU DIED / BONFIRE LIT / VICTORY ACHIEVED; colours in the script fields) |

## 11. Step-by-step swap procedures

> Open the imported **Dungeon** project first. Save (Ctrl+S) after each step.

### 11.1 Import a character model

1. In the Assets panel, choose **+ Add ▸ Import Files…** (or drop the `.fbx` / `.glb` on the panel).
2. In the review modal, enable **Normalize scale** if the model is not in metres, then confirm. A Mixamo
   character comes in several parts (body, clothes, hair): **Merge sub-meshes into a single mesh** makes
   it one model with one material per part, which is what the character scripts expect.
3. You get a `.model` asset, its materials, and a `.rig` for its skeleton.

Textures embedded in the `.fbx` (Mixamo embeds them) are found automatically: the review modal says
"All referenced textures are present". A 120 MB Mixamo character imports in well under a minute, in the
background; most of that is the converter itself.

**A Mixamo character on the mannequin's animations.** Mixamo rigs name their bones `mixamorig:Hips`,
the mannequin's are `mixamorig1:Hips`; the prefix is ignored when bones are matched, so a Mixamo model
plays every mannequin clip once its rig is set to **Mannequin** (§11.6).

### 11.2 Import and retarget animations

1. Choose **+ Add ▸ Animation** and pick the clip file(s).
2. **Rig picker:** choose the rig the clips are for. For the player, that is the rig of the model from
   §11.1, or `Mannequin` to keep the placeholder body.
3. **Bone mapping table:** check the rows, and fix any marked *none* or obviously wrong by hand.
4. **Clip list:** tick the clips and **rename** them. Either use the exact placeholder names (§6),
   so nothing else needs changing, or use your own names and repoint the fields as in §11.3.
5. Leave **Root motion** off. The clips must be in place.

### 11.3 Point a move or attack at a new clip

Clips are picked in the animators, not the scripts: open the character's animator (**Souls Character** for
the player, **Souls Hollow** and the others for the enemies), pick the **Actions** layer tab, select the
state and set its clip, speed and **Start at** there.

- **Player attack:** the states are entered by triggers named `<Weapon> <Move>` (`Longsword Light1`). The
  move itself — the weapon template's `Light1` (**Assets ▸ Templates ▸ Weapons ▸ Longsword**) — keeps its
  gameplay: `staminaCost`, the `lunge*` fields, its `animTrigger`. Reach comes from the blade itself: if
  the new swing misses, lengthen the lunge or the weapon's `bladeEnd`/`bladeRadius`.
- **Player one-shots:** the states the `Roll`, `Drink`, `HitLight`, … triggers enter. `Player`'s
  `*Trigger` fields name the triggers.
- **Enemy attack:** the state its trigger (the attack's name) enters in its type's animator.
- **Add an attack:** duplicate an existing `Attacks` child and rename it, then add a state to the type's
  Actions layer with an **Enter on trigger** of that name. For a weapon, duplicate a move in its
  template, rename it, add a state to **Souls Character** entered by a new trigger, pick that trigger as
  the move's `animTrigger`, and point the previous move's `next` at it.

### 11.4 Add the event markers

1. Open the clip's `.anim` from Assets to get the clip editor.
2. Move the playhead to the contact frame, press **+ Event at playhead**, and name it `hit`.
   Add `combo` and `recover` the same way for player attacks, `drink` on the drink clip, and `cast` on cast clips.
3. Drag a marker to retime it. Click it to rename it; double-click it to delete it.

### 11.5 Sockets on a new rig

1. Open the new `.rig` from Assets.
2. Select the right-hand bone in the Skeleton panel, press **+ Add socket on *bone***, and name it **RightHand**.
   Do the same for **LeftHand**.
3. Optionally set the socket **Position / Rotation** so held items sit in the palm.

### 11.6 Replace a character's model

The scripts find the model automatically: it is the first **Model** child that has an animator. So:

1. Open the character's template: **Player** for the player, the enemy's template for an enemy
   (double-click it under `Assets ▸ Templates`). Drag your `.model` from Assets onto the template's
   root so it becomes a child. Saving the template updates the placed `Player` too.
2. Select the new model node and, in its **Rig** section, link **Mannequin** to play the placeholder
   clips (or your own rig, once it has clips). Linking the rig also gives the node the **Souls Character**
   animation controller — idle, locomotion and death — when it has none: the character's state machine
   lives on its model node, so a freshly dropped model starts without one, and without one it walks
   around in its bind pose (attacks still play, which is what makes it confusing). If the Logger says
   *"has no animation controller"*, pick **Souls Character** in the node's **Animation** section.
3. Delete the old model node.
4. Keep the order of children. On the player, `camera rig` comes first and `Player Controller` last.
   On enemies, `Brain` stays last.
5. Re-fit the capsule in the **Physics** section on the character root if the new body is larger.
   On enemies, move `LockPoint` and `HealthAnchor`.
6. Re-attach weapons with **Attach to socket**. Each `Weapon` node's **Socket** must name a socket your
   rig has (§11.5).

**Only re-colouring?** Open the `(placeholder)` material from Assets and edit it. Every node using it updates.

### 11.7 Replace a weapon, or add one

**Replace:**
1. Import the weapon model (§11.1).
2. Open the weapon's template (**Assets ▸ Templates ▸ Weapons ▸ Longsword**). Under `Mesh`, delete
   the placeholder boxes and drag your weapon model in as a child of `Mesh`.
3. Play, and adjust `Mesh`'s rotation and position until the grip sits in the hand. The weapon root
   cannot be moved while it is attached.
4. Tune its numbers in its **Scripts** section (`displayName`, `baseDamage`, `strScaling`, `dexScaling`,
   the requirements, `poiseDamage`, the blade). A changed value shows **revert**, back to the base's.

**Add a new weapon:**
1. Right-click the **Weapon** template ▸ **Create Variant**. Rename it (e.g. `Battle Axe`).
2. Give it its look under `Mesh`, and its moves: duplicate the `Light1`/`Heavy` move nodes from the
   Longsword, or add `SoulsMove` nodes, each naming its clip.
3. For its own stats as code, write `SoulsBattleAxe.ts` extending the base weapon and only setting
   defaults, and attach it to the variant's root:
   ```ts
   import SoulsWeaponNode from './SoulsWeapon'
   export default class SoulsBattleAxeNode extends SoulsWeaponNode {
     public displayName: string = 'Battle Axe'
     public baseDamage: number = 140
     public strScaling: number = 0.9
   }
   ```
   (Or keep the base script and set the values on the variant's root — both work.)
4. Hand it to someone: add its name to their `weaponTemplates` (`Longsword, Greatsword, Battle Axe`).
   Weapon swap cycles every weapon the player carries.

### 11.8 Level art

1. Import the level meshes and place them.
2. For every walkable or blocking surface, keep a collider: either an existing `Level` box (hide its
   mesh) or a new body in the **Physics** section.
3. Move the **Enemy Spawns** nodes. Each one's position and facing is where its enemy stands. To place
   another one, drag the `Enemy Spawn` template in, then pick what it spawns in its Scripts section.
4. Move the `Fog Gate` so local +Z points into the arena, and resize the `Boss Arena` node's trigger box
   to cover the arena past the fog.
   Mark new walls and pillars with the `blocksSwings` variable (boolean, true) so swings bounce off them.
5. **Torches, messages, pickups:** place more by dragging the template from Assets into the viewport.
   Give a new message its text, and a new pickup what it gives, in the copy's Scripts section.
6. Re-bake the navmesh (§11.11).

### 11.9 Sounds

1. Drop the audio files on Assets, or use **+ Add ▸ Sound**. Set loop points on the music in the sample editor.
2. Open each template in the §8 table (double-click it in Assets). Select each node under its `Sounds`,
   set **Sample** and save. For the game-flow cues and the music, use the nodes under
   `GameManager/Sounds` in the scene. Leave **Play on start** off, except on `Ambience`.

### 11.10 Effects

- Edit a `.vfx` under `Assets ▸ Effects`. **Save** pushes the change into every node that links it.
- Or drag a different `.vfx` onto a Particle System node's **Effect** slot.

### 11.11 Navmesh

The `Nav Mesh` node ships **unbaked**. Without a bake, enemies chase in a straight line, which is fine for
the blockout.
1. Select `Nav Mesh` and press **Fit to scene**, then **Bake**.
2. Re-bake after any change to the level geometry. The bake reads colliders, not meshes.

### 11.12 Rebind controls

Use **Input mode ▸ Input panel**. Click a binding and use **press-to-rebind**. The action names in §2 are
what the scripts read, so rename an action only together with the script that reads it.

## 12. Tuning reference

### Player (template **Player** → Scripts; or override on the placed `Player`)

| Field(s) | Default | Meaning |
|---|---|---|
| `jogSpeed` / `sprintSpeed` | 3.8 / 5.8 m/s | Movement speeds. Sprint is Roll held for longer than `sprintHoldSeconds` (0.25 s). |
| `lockedSpeedScale` | 0.8 | Strafe speed while locked on. |
| `staminaRegen` / `staminaRegenDelay` | 45 /s after 0.6 s | No regeneration while sprinting, rolling or attacking. |
| `sprintCostPerSecond` / `exhaustThreshold` | 14 / 15 | Sprinting to empty locks sprint until stamina recovers to 15. |
| `rollCost`, `rollSeconds` | 20, 0.7 s | Roll stamina cost and duration. |
| `rollInvulnStart` → `rollInvulnEnd` | 0.06 → 0.42 s | The roll's i-frames. |
| `rollSpeed` / `rollSlowSpeed` | 6.5 / 2 m/s | Roll speed for the first `rollFastSeconds`, then the slower tail. |
| `backstepCost`, `backstepInvulnEnd` | 12, 0.22 s | Backstep stamina cost and i-frames. |
| `estusMax`, `estusHeal`, `estusHealSeconds` | 3, 250 HP, 0.4 s | Flask count, and the heal spread over that time. |
| `heavyHitThreshold` | 150 | Damage at which a hit becomes a heavy stagger with knockback. |
| `inputBufferSeconds` | 0.3 s | How long a press is remembered. |
| `killY` | −15 | Falling below this height kills the player. |

### Rules — each lives with what it describes

| Rule | Owner | Formula |
|---|---|---|
| HP | `SoulsPlayer.hpForVigor` (`baseHp`, `hpPerVigor`) | `400 + 30·(Vig−10)` up to Vigor 30, then +12 per point to 40, then +5 per point. |
| Stamina | `SoulsPlayer.staminaForEndurance` | `90 + 3·(End−10)` up to Endurance 40, then +1 per point. |
| Level cost | `SoulsPlayer.levelCost` / `levelFor` | `400 + 120·(L−1) + 4·(L−1)²`. Level = 1 + every point spent. |
| Attack rating | `SoulsWeapon.attackRating` (`unmetRequirementPenalty`) | `base × (1 + strScaling·bonus(STR) + dexScaling·bonus(DEX))`, ×0.6 if a requirement is unmet.<br>`bonus` (`SoulsMath.statBonus`) is 0 at stat 10, 0.6 at 30 and 0.9 at 50. |
| Damage taken | `SoulsCharacter.applyDefense` (the target's `defense`) | `max(1, damage × (1 − defense))` |
| Enemy attack choice | `SoulsEnemy.pickAttack` | in range, off cooldown, unlocked by `phase`, not a repeat; then by `weight` |

### Weapons (each weapon's script → its defaults; override on the template)

| Weapon | Base | Scaling | Requirements | Poise |
|---|---|---|---|---|
| Longsword | 112 | STR 0.5 / DEX 0.5 | STR 10, DEX 10 | 20 |
| Greatsword | 165 | STR 1.0 / DEX 0.15 | STR 16 (starting STR is 10, so it begins penalised) | 32 |

| Moves | Stamina | Damage multiplier |
|---|---|---|
| Sword Light1 / Light2 / Light3 | 16 / 16 / 20 | 1.0 / 1.0 / 1.15 |
| Sword Heavy | 30 | 1.6 (poise ×2) |
| Greatsword Light1 / Light2 | 26 | 1.0 / 1.05 |
| Greatsword Heavy | 42 | 1.7 (poise ×2) |

### Enemies (each type's script → its defaults; attacks under `Attacks` in its template)

| Enemy | HP | Defense | Poise | Souls | Notes |
|---|---|---|---|---|---|
| Hollow | 160 | 0 | 25 | 120 | **Swing** 70, **Sweep** 60; leash 18 m |
| Hollow Sorcerer | 110 | 0 | 15 | 160 | Keeps 7–14 m away; **Bolt** 90 at 12 m/s, 3.5 s cooldown; **Shove** up close |
| Elite Knight | 650 | 0.15 | 70 | 900 | **Sweep** 140; **Overhead** 190 with hyper armour; **Thrust** 150, lunging 4–9 m |
| Hollow Warden | 2600 | 0.2 | 150 | 6000 | Never flinches.<br>**Phase 1:** **Sweep** → **Backsweep** combo, **Slam** 220, **Lunge** 160.<br>**Phase 2** (≤50%): ×1.15 speed, adds **Leap** 200 (3.8 m AoE) and a 3-bolt **Bolt Fan**. |

**Shared fields:**

| Field | Default | Meaning |
|---|---|---|
| `strafeSpeedScale` / `retreatSpeedScale` | 0.35 / 0.7 | How fast it circles and backs off in the graph's Strafe and Retreat states. |
| `attackGapMin` / `attackGapMax` | — | Pause between attacks. |
| `flinchOnHit` | — | Whether ordinary hits make it flinch. |
| `poiseRegenDelay` | 3 s | Poise refills after this long without being hit. |
| `phase2At` | 0.5 | Warden only (`SoulsHollowWarden`): phase-two threshold, as a fraction of HP. |
| `phase2SpeedMul` | 1.15 | Warden only: speed multiplier in phase two. |

**Brain fields** (on `Brain`): `perception.range` and `fieldOfView` set how far and how wide the enemy
can see you.

**AI graphs.** Each enemy type's behaviour is an AI graph asset under **Assets ▸ AI**
(`Hollow Brain.brain`, `Hollow Sorcerer Brain.brain`, …), linked from its `Brain` controller. Open one to
see and edit the whole fight as states and transitions:

| State | Goal | Entered when |
|---|---|---|
| Idle | idle | start; back home after a Return |
| Chase | path | awake, a target, and the target alive |
| Approach | seek | `Distance` under the type's engage range |
| Strafe | script | inside the spacing band (`Distance` under its far edge) |
| Retreat | script | Sorcerer only: closer than the band's near edge (7 m) |
| Attack | script | `Attack Ready` — the script picks which attack |
| Stagger | script | `Reacting` (a flinch or a stagger) |
| Phase Shift | script | Warden only: its invulnerable turn into phase two |
| Return | path to home | past the leash from home, or the target died; holds until home |
| Dead | idle | `Dead` |

The numbers — engage range, spacing band, leash — are values in the transitions, per type:

| Type | Engage | Band | Leash |
|---|---|---|---|
| Hollow | 4 m | 0–1.5 m | 18 m |
| Hollow Sorcerer | 18 m | 7–14 m | 22 m |
| Elite Knight | 9 m | 0–2.6 m | 14 m |
| Hollow Warden | 12 m | 0–3.6 m | never |

The graph reads the enemy through **builtin** parameters (its own fields and getters: `isDead`,
`isAwake`, `attackReady`, `isAttacking`, `isReacting`, `isPhaseShifting`, `targetDead`,
`distanceFromHome`) and perception through **senses** (`hasTarget`, `distanceToTarget`). The script only
carries out the state: it draws the attack in Attack, circles and back-pedals facing you in Strafe and
Retreat, and plays reactions. Editing a brain asset updates every enemy of that type.

## 13. Regenerating the example, tests, limitations

The example folder `applications/editor/public/examples/dungeon/` is **generated** with the Valley's (see
`tools/valley/README.md` for the source art it needs, and for `split.ts`, which makes the two projects):

```
node --max-old-space-size=12288 tools/valley/build.mjs   # rebuild (deterministic; re-runs are byte-identical)
npm --prefix applications/editor run examples:list       # refresh the gallery index
npx vitest run tests/soulsDemo tests/dungeon             # rules + generated-project checks
```

- `tools/soulsDemo/build.mjs` holds the templates, UI, materials and effects; `tools/valley/` the level.
- `tools/soulsDemo/seed/` is the mannequin, its material, textures and locomotion field the characters
  are built from.
- `placeholderClips.mjs` holds the procedural stub animations, posed in character space.
- `inputMap.mjs` holds the bindings.
- Your art swaps happen in **your imported project**, not here. Edit the generator only to change what
  the example ships with.
- `tests/dungeonSouls.test.ts` checks every name-based join: clips and their events, templates,
  sounds, widgets, input actions, sockets and child order. Run it after changing the generator.

**Known limitations:**
- **Placeholder clips are crude.** They exist for timing and events. The roll is an in-place somersault.
- **One-shots never move the character themselves.** An Actions state either extracts its clip's travel
  for the script (the roll, the Longsword) or plays in place while the script lunges.
- **Hurtboxes are whole-body capsules.** A blade that grazes an outstretched arm outside the capsule
  does not count, and there are no head or limb multipliers.
- **Enemy reach comes from the placeholder swings.** The attacks' `maxRange` values were measured against
  where each blade actually lands; a replacement clip needs them re-checked.
- **The player has no poise.** Every hit outside i-frames interrupts.
- **No blocking or parrying, and no inventory beyond the two weapons and the flask** — by design for this demo.
- **The level-up menu is keyboard/gamepad first.** The +/- and Confirm/Leave buttons also accept mouse clicks.
