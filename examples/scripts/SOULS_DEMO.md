# Hollow Keep — a souls-like demo

*Hollow Keep* is a one-level souls-like built from placeholders. The mechanics are all real; the art is
not. Every character is the engine's mannequin in a tinted material, the level is boxes and cylinders,
and the animations are procedural stubs. This document covers how the demo works and how to replace each
placeholder with final art from inside the editor, without touching a script.

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

1. Open the project launcher and go to **Examples ▸ Hollow Keep**, then press **Download**. The example
   (about 83 MB) is copied into a **new project**, so your other projects are untouched.
2. Wait for the scene to finish loading, then press **Play** (▶).
3. Click the game view to capture the mouse.

Everything you change in that project, whether art, tuning or bindings, is saved in that project like
any other. The example folder in the repository is only the starting point.

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

```
       ┌──────────── G. Boss arena (36×36) ──────────────┐   Hollow Warden, reward, epilogue
       └──────────────────┤ fog gate ├───────────────────┘
                     F. Approach (lore message)
 ┌──── C. Courtyard ────┬──── D. Elite hall ────┐
 │ 2 Hollows, Sorcerer  │ Elite Knight, souls   │
 │ on a ledge, Estus    │                       │
 │ Shard, pillars       ├─────┐                 │
 └──────┤      ├────────┘     │ E. Shortcut     │
        B. Corridor           │ corridor (Hollow)│
        2 Hollows, souls      │                 │
 ┌──────┤      ├─────────┐    │                 │
 │ A. Bonfire yard       ╞════╛ lever + gate (opens from the far side)
 │ start, bonfire, message
 └───────────────────────┘
```

| Area | Contents |
|---|---|
| A. Bonfire yard | Player start, the bonfire, the first message, and the shortcut gate (locked from this side). |
| B. Corridor | A rolling tutorial message, two Hollows, and a souls pickup. |
| C. Courtyard | Two Hollows, the Sorcerer on a ledge with a ramp, an Estus Shard, and a warning message. |
| D. Elite hall | The Elite Knight, a souls pickup, and a message. |
| E. Shortcut | A Hollow, then the lever that opens the gate back into the yard. |
| F. Approach | A lore message and the fog gate. |
| G. Arena | The Hollow Warden. On victory, a reward pickup and an epilogue message appear. |

The **game loop**:
- **Bonfire:** light it, then rest to heal, refill flasks and level up. Resting respawns every enemy
  except a defeated boss, and the bonfire becomes your respawn point.
- **Death:** your souls drop as a bloodstain where you fell. Touch it to recover them. Die again first
  and they are gone for good.
- **Boss:** walk through the fog to wake the boss. Below half health it roars and enters phase two:
  it gets faster and adds a leap slam and a bolt fan. Dying mid-fight resets the boss and the fog.

## 4. How the scripts fit together

All scripts live in `examples/scripts/Souls*.ts` and are installed in the project as Script assets.
Pure helpers (`num`, `yawTo`, `angleDiff`, …) live in the **SoulsMath** script module, which the
others import with `import { yawTo } from './SoulsMath'`. Game state flows through the
**GameManager** and through node names:

| Script | Node | Role |
|---|---|---|
| `SoulsGameManager` | `GameManager` | Balance rules: HP and stamina curves, attack rating, level cost, attack choice, lock ranking.<br>Registries of enemies, interactables and spawns.<br>Rest, death and respawn, bloodstains, the boss fight.<br>`sfx()`, `fx()`, banners, notices. |
| `SoulsPlayer` | `Player` (Character) | Stats, HP, stamina and Estus.<br>The action state machine (free, attack, roll, backstep, drink, swap, hit, rest, fog, dead) with input buffering.<br>Interact prompt. |
| `SoulsLockOn` | `Player/camera rig` | Orbit camera plus target lock, switching and the reticle. |
| `SoulsWeapon`, `SoulsMove` | `Player/Weapons/*` | A weapon's stats, plus one child node per attack. |
| `SoulsEnemy` | every enemy template root | HP, poise, flinch and stagger, spacing and strafing, attack choice, the boss phase, death. |
| `SoulsEnemyAttack` | `<enemy>/Attacks/*` | One enemy attack per node. |
| `SoulsEnemyBrain` | `<enemy>/Brain` (last child) | Player-only targeting (the engine has no factions), plus blackboard flags for the behaviour machine. |
| `SoulsEnemySpawn` | `Enemy Spawns/*` | Instantiates a template, and re-creates it on rest or death. |
| `SoulsProjectile` | `Magic Bolt` template | Swept-raycast flight; a roll's i-frames let you pass through. |
| `SoulsFx` | effect templates | Bursts its particles, fades its lights, then removes itself. |
| `SoulsBonfire`, `SoulsPickup`, `SoulsBloodstain`, `SoulsMessage`, `SoulsLever`, `SoulsDoor`, `SoulsFogGate` | interactables | Each one follows the **interactable protocol** below. |
| `SoulsHud`, `SoulsBanner`, `SoulsBonfireMenu` | UI roots | The HUD, the big banners, and the level-up menu. |

**Interactable protocol.** An interactable registers with the GameManager and exposes these members:
- `interactRadius`
- `canInteract(player)`
- `promptText(player)`
- `interact(player)`

The player prompts for the nearest interactable in range. To make a new kind, copy `SoulsMessage.ts`.

**Editing behaviour.** Every number in the tables below is a **public field**, so it appears in the
node's **Scripts** section in the inspector. A field edited on a node overrides the code default. Fields
on nodes inside a template are edited in **Template mode**: open the `.tpl` from Assets.

### Templates and placed copies

Everything placed more than once, or replaced as one piece of art, is a **template**, and the scene
holds **linked copies** of it:

| Template (`Assets ▸ Templates`) | Copies in the scene |
|---|---|
| `Level/Player` | `Player` |
| `Level/Torch` | the 19 torches under `Torches` |
| `Level/Bonfire` | `Interactables/Bonfire` |
| `Level/Lever`, `Level/Gate` | `Interactables/Shortcut Lever`, `Interactables/Shortcut Gate` |
| `Level/Fog Gate` | `Interactables/Fog Gate` |
| `Interactables/Message` | the 7 `Message: …` nodes and `Epilogue Message` |
| `Interactables/Pickup` | `Souls Pickup`, `Estus Shard`, `Hall Souls`, `Boss Reward` |
| `Enemies/*` | none placed: the **Enemy Spawns** instantiate them at runtime, and again on every rest |

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
- `Shortcut Lever` and `Shortcut Gate` override only their names, which is how the lever finds its door
  (`doorName`) and how the scripts find both.

Scripts look nodes up **by name** (`Player`, `Boss Reward`, `Epilogue Message`, `Shortcut Gate`, the
`Fire` inside a bonfire), so keep those names when you rename or replace things.

## 5. The asset manifest

Conventions for **all final art**:
- **Units:** metres. **Up:** +Y. **Forward:** +Z, so characters face +Z in their bind pose.
- **Characters** are humanoid and Mixamo-compatible, or anything the retargeter can map. They are about
  1.8 m tall, with the boss at about 3.2 m.
- **Clips are in place.** One-shot actions ignore root motion (see §6).
- **Weapons:** the grip sits at the origin and the blade or shaft runs along local **+Y**.

### Characters

| Placeholder | Where | Replace with | Notes |
|---|---|---|---|
| Mannequin, untinted | Template **Player**: `Player/Ch36` | The player character | Keep the `Weapons` group and `Player Controller` as they are. The capsule is on `Player` (r 0.3, h 1.78). |
| Mannequin, grey-green (`Hollow (placeholder)` material) | Template **Hollow**: `Hollow/Ch36` | Basic undead soldier | Club in `Weapon/Mesh`. |
| Mannequin, blue (`Caster (placeholder)`) | Template **Hollow Sorcerer** | Robed caster | Staff in `Weapon/Mesh`. Bolts leave from the **LeftHand** socket. |
| Mannequin ×1.2, red (`Elite Knight (placeholder)`) | Template **Elite Knight** | Armoured knight | Greatsword in `Weapon/Mesh`. |
| Mannequin ×1.8, dark metal (`Hollow Warden (placeholder)`) | Template **Hollow Warden** | The boss | Halberd in `Weapon/Mesh`. Capsule r 0.45, h 3.2. |

Each enemy template also holds a **LockPoint** (chest height, where the lock-on aims) and a
**HealthAnchor** (above the head, where the floating health bar sits). When you swap in a
taller or shorter model, move these two nodes to match.

### Weapons (the player)

| Placeholder | Where | Replace with |
|---|---|---|
| Three boxes: blade, guard and grip | Template **Player**: `Weapons/Weapon_StraightSword/Mesh` | Straight sword mesh |
| Three boxes | Template **Player**: `Weapons/Weapon_Greatsword/Mesh` | Greatsword mesh |

### Level and props

| Placeholder | Where | Replace with |
|---|---|---|
| ~60 boxes and cylinders with colliders | Scene: `Level/*` | Your level art. Keep, or rebuild, **colliders** where people walk: the bake and the characters use colliders, not meshes. |
| Torch posts with a fire particle and a point light | Template **Torch** (19 copies under `Torches`) | Torch props. One edit to the template changes every torch. |
| Ash disc, stones and a sword (`Bonfire/Model`) | Template **Bonfire**: `Bonfire/Model` | The bonfire. Keep `Fire`, `Fire Light` and `RespawnPoint`; the respawn point is where, and facing where, you stand up. |
| Iron box (`Gate/Bars`) | Template **Gate** (copy: `Interactables/Shortcut Gate`) | Portcullis or door. The collider is on the template root (3.2 × 4 × 0.4), and it slides by `openOffset`. |
| Stone block and bar (`Lever/Base`, `Handle/Stick`) | Template **Lever** (copy: `Interactables/Shortcut Lever`) | The lever. `Handle` swings about its X axis. |
| Translucent sheet (`Fog Gate/FogWall`) plus `Fog` particles | Template **Fog Gate** | The fog wall. The collider is on the template root (6 × 4 × 0.5), and local +Z points into the arena. |
| Orange glyph (`Message/Glyph`) | Template **Message** (7 copies + `Epilogue Message`) | Message sigil |
| Glowing sphere (`Pickup/Item`) | Template **Pickup** (4 copies) | Item or corpse prop |
| Glowing splat decal (`Bloodstain/Pool`) | Template **Bloodstain** | Bloodstain decal: change the `Bloodstain Decal (placeholder)` material's texture, or replace `Pool` with a prop |
| Blood splat and spatter decals | Templates **Blood Splat**, **Blood Drops** (`Decal` child) | Your blood decals: change the texture on `Blood Splat (placeholder)` / `Blood Drops (placeholder)` (§9) |
| Blue sphere (`Magic Bolt/Core`) | Template **Magic Bolt** | Projectile visual |

### Materials

The character materials keep the mannequin's textures with a colour tint. Prop materials are flat
colours. All of them are under `Assets ▸ Materials` with **(placeholder)** in the name. Edit them in
place, or assign your own (§11.6).

## 6. Animation contract

### State machine on every character model

Attacks, rolls and reactions are **actions** played over the state machine by script. The machine itself
only needs this:

| States | Parameters | Transitions |
|---|---|---|
| **Idle** (entry, loop)<br>**Locomotion** (blend space `Souls Locomotion`: Direction × Speed)<br>**Dead** (clip `Souls_Death`, no loop) | `Speed` → built-in `planarSpeed`<br>`Direction` → `planarAngle`<br>`Died` trigger<br>`Revive` trigger | Idle ⇄ Locomotion on Speed 0.5<br>Idle / Locomotion → Dead on `Died`<br>Dead → Idle on `Revive` |

If you build a new machine for a new model, keep the two trigger names. The scripts fire `Died` and
`Revive` by name.

### Clips the player uses

| Clip (placeholder name) | Length | Required events | Referenced by |
|---|---|---|---|
| `Souls_Sword_L1` / `L2` / `L3` | 0.9 / 0.9 / 1.1 s | `hit`, `combo`, `recover` | `Weapon_StraightSword/Light1..3` → `clip` |
| `Souls_Sword_Heavy` | 1.4 s | `hit`, `recover` | `Weapon_StraightSword/Heavy` → `clip` |
| `Souls_GS_L1` / `L2` | 1.4 s | `hit`, `combo`, `recover` | `Weapon_Greatsword/Light1..2` → `clip` |
| `Souls_GS_Heavy` | 2.0 s | `hit`, `recover` | `Weapon_Greatsword/Heavy` → `clip` |
| `Souls_Roll` | 0.7 s | — | `Player` → `rollClip` |
| `Souls_Backstep` | 0.45 s | — | `Player` → `backstepClip` |
| `Souls_Drink` | 1.4 s | `drink` (when the heal starts) | `Player` → `drinkClip` |
| `Souls_HitLight` / `Souls_HitHeavy` | 0.45 / 0.9 s | — | `Player` → `hitLightClip` / `hitHeavyClip` (also the enemies' flinch and stagger) |
| `Souls_Swap` | 0.4 s | — | `Player` → `swapClip` |
| `Souls_Rest` | 1.2 s, loops | — | `Player` → `restClip` (sitting at the bonfire) |
| `Souls_Interact` / `Souls_Pickup` | 0.9 / 0.8 s | — | lever, bonfire lighting / pickups, bloodstain |
| `Souls_FogWalk` | 1.5 s | — | `Player` → `fogWalkClip` |
| `Souls_Death` | 1.5 s | — | the `Dead` state |
| `Idle`, `Walk`, `Run`, strafes, backwards, diagonals | — | — | the `Souls Locomotion` blend space |

### Clips the enemies use

| Clip | Length | Required event | Referenced by |
|---|---|---|---|
| `Souls_Enemy_Swing` | 1.2 s | `hit` | Hollow `Swing`, Sorcerer `Shove` |
| `Souls_Enemy_Sweep` | 1.3 s | `hit` | Hollow `Sweep`, Knight `Sweep`, Warden `Sweep` |
| `Souls_Enemy_Overhead` | 1.7 s | `hit` | Knight `Overhead`, Warden `Slam` |
| `Souls_Enemy_Thrust` | 1.2 s | `hit` | Knight `Thrust`, Warden `Lunge` |
| `Souls_Cast` | 1.2 s | `cast` (the bolt leaves) | Sorcerer `Bolt`, Warden `Bolt Fan` |
| `Souls_Leap` | 1.8 s | `hit` (landing) | Warden `Leap` |
| `Souls_Roar` | 2.0 s | — | Warden → `roarClip` (phase two) |
| `Souls_GS_L2` | 1.4 s | `hit` | Warden `Backsweep` (follows `Sweep`) |

### What the events mean

| Event | Meaning |
|---|---|
| `hit` | The contact frame. Damage is dealt to everything in range and in the arc at that instant, so a roll during the wind-up genuinely avoids it. A clip may carry several `hit`s for multi-hit swings. |
| `combo` | From here, a buffered attack chains into the move named in `next`. |
| `recover` | From here, a buffered roll or drink may cancel the rest of the swing. |
| `drink` | The flask is consumed and the heal begins. |
| `cast` | Projectiles spawn at the cast socket. |

**No events yet?** A clip without a `hit` event still works. The move's `hitTime`, `comboTime` and
`recoverTime` fields (clip seconds) are used instead. Import first, add markers later.

**In place.** Actions ignore root motion, so a lunge or roll forward is driven by script: `lungeStart`,
`lungeSeconds` and `lungeSpeed` on moves and attacks, and `roll*` on the player. Bake root motion out on
export, or leave the clip's **Root motion** toggle off.

## 7. Sockets and weapon grips

The `Mannequin` rig has two sockets: **RightHand** (`mixamorig1:RightHand`) and **LeftHand**. Weapons
attach with **Attach to socket ▸ Nearest character above ▸ RightHand**. A new rig needs the same two
socket names; see §11.4.

While attached, the weapon node's transform is driven every frame. **Adjust the grip on its `Mesh` child**,
whose position and rotation are relative to the hand. The generator computed the placeholder grips
so the blade points forward and down at idle. Socket scale ignores the bone's scale, which is why each
enemy's weapon is sized in its `Mesh` child rather than inherited from the scaled body.

## 8. Sound cues

Every cue is an **empty Ambient Sound node** under `Sounds`. Assign a sample to each one to hear it.
A node with no sample is silent, and nothing breaks.

| Node | Played when |
|---|---|
| `Swing`, `Swing Heavy` | the player starts a light or heavy attack |
| `Hit` | a player attack connects |
| `Roll` | roll or backstep |
| `Drink` | an Estus flask is consumed |
| `Player Hurt` | the player takes damage |
| `Player Hit` | an enemy swing connects (impact) |
| `Death` | YOU DIED |
| `Souls` | souls gained |
| `Pickup` | an item is picked up |
| `Bonfire Lit` | a bonfire is lit |
| `Rest` | sitting at a bonfire |
| `Level Up` | the level-up is confirmed |
| `Menu Tick` | a point is adjusted in the menu |
| `Menu Deny` | not enough souls |
| `Lock On` | a target is locked |
| `Enemy Swing` | an enemy attack starts (each attack's `sound` field can name another node) |
| `Stagger` | an enemy's poise breaks |
| `Enemy Death` | an enemy dies |
| `Cast` | a projectile is fired |
| `Bolt Impact` | a projectile hits |
| `Door` | the shortcut gate opens |
| `Lever` | the lever is pulled |
| `Fog` | walking through the fog |
| `Boss Roar` | the boss enters phase two |
| `Boss Leap` | the boss's leap attack (its `sound` field) |
| `Victory` | the boss is defeated |
| `Ambience` | loops from the start; stopped during the boss fight |
| `Boss Music` | loops during the boss fight |

## 9. Visual effects

All effects are `.vfx` assets under `Assets ▸ Effects`, embedded in Particle System nodes.

| Effect | Used by |
|---|---|
| Bonfire Fire | `Bonfire/Fire` (plays once the bonfire is lit) |
| Torch Fire | `Torches/*/Fire` |
| Fog Wall | `Fog Gate/Fog` |
| Magic Bolt Trail | template `Magic Bolt/Trail` |
| Magic Bolt Impact | template `Bolt Impact` |
| Hit Spark | template `Hit Spark` (on every player hit) |
| Slam Dust | template `Slam Dust` (boss slam and leap) |
| Item Glow, Message Glow | pickups and messages |
| Bloodstain Glow | template `Bloodstain` |
| Phase Two Aura | `Hollow Warden/PhaseAura` (starts at phase two) |
| Blood Spray | template `Blood Spray` (droplets thrown off every landed hit) |

The effect templates carry `SoulsFx` with a `lifetime` field. Make it at least as long as the effect.

### Blood

Every hit that lands, on an enemy (`SoulsEnemy.receiveHit`) or on the player (`SoulsPlayer.receiveDamage`,
melee and bolts alike), calls `GameManager.bleed`, which spawns three things:

| Template | What it is |
|---|---|
| `Blood Spray` | Dark droplets flying off the wound (particles, `SoulsFx`). |
| `Blood Splat` | A pool **decal** under the body. |
| `Blood Drops` | A spatter **decal** a step further along the blow, pointed away from the attacker. |

The two decal templates carry `SoulsBloodSplat`. On its first frame it raycasts down to find the floor
(it removes itself when there is none within `snapDown`), moves onto it, tilts to match a ramp, picks a
random size between `minSize` and `maxSize` times the hit's size, and after `lifetime` seconds fades out
over `fadeSeconds` and is removed. The splat scales with damage: `bloodReferenceDamage` (120) is a
full-size splat, from 0.6× to 1.6×.

**GameManager fields:** `bloodEnabled` (off: no blood at all), `bloodSprayTemplate`,
`bloodSplatTemplate`, `bloodDropsTemplate`, `maxBloodDecals` (24; the oldest is removed first, so a long
fight never piles up decals), `bloodReferenceDamage`.

**Swapping the art.** The splat images are generated placeholders (`tools/soulsDemo/png.mjs`) on the
`Blood Splat (placeholder)` and `Blood Drops (placeholder)` materials under `Assets ▸ Materials ▸ Effects`.
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

The UI scripts find widgets **by name**, so you can restyle, move or rebuild anything as long as the names
stay. A missing widget is simply skipped.

| Root | Widgets |
|---|---|
| `HUD` | **Bars:** `Health`, `HealthLag` (the yellow drain), `HealthBack`, `Stamina`, `StaminaBack`. Bars grow with max HP and stamina (`pxPerHp`, `pxPerStamina`).<br>**Text:** `Estus`, `Weapon`, `Souls`, `SoulsGain`, `Notice`.<br>**Prompt:** `Prompt` panel holding `PromptText`.<br>**Message panel:** `Message`, `MessageTitle`, `MessageBody`.<br>**Boss bar:** `Boss` group, `BossName`, `BossHealth`, `BossLag`.<br>**Help:** `Controls` (static). |
| `Banner` | `Band`, `BannerText` (YOU DIED / BONFIRE LIT / VICTORY ACHIEVED; colours in the script fields) |
| `BonfireMenu` | `Title`, `LevelText`, `SoulsText`, `CostText`, `Derived`, `Help`.<br>`Row_Vigor` / `Row_Endurance` / `Row_Strength` / `Row_Dexterity`, each containing `Label`, `Minus`, `Value` and `Plus`.<br>`Confirm`, `Leave`. |
| `LockReticle` | A world-space root with a `Dot`. Any widget works; it follows the target's `LockPoint`. |
| `<enemy>/HealthBar` | A world-space root with a `Fill` progress bar that follows `HealthAnchor`. |

## 11. Step-by-step swap procedures

> Open the imported **Hollow Keep** project first. Save (Ctrl+S) after each step.

### 11.1 Import a character model

1. In the Assets panel, choose **+ Add ▸ Import Files…** (or drop the `.fbx` / `.glb` on the panel).
2. In the review modal, enable **Normalize scale** if the model is not in metres, then confirm.
3. You get a `.model` asset, its materials, and a `.rig` for its skeleton.

### 11.2 Import and retarget animations

1. Choose **+ Add ▸ Animation** and pick the clip file(s).
2. **Rig picker:** choose the rig the clips are for. For the player, that is the rig of the model from
   §11.1, or `Mannequin` to keep the placeholder body.
3. **Bone mapping table:** check the rows, and fix any marked *none* or obviously wrong by hand.
4. **Clip list:** tick the clips and **rename** them. Either use the exact placeholder names (§6),
   so nothing else needs changing, or use your own names and repoint the fields as in §11.3.
5. Leave **Root motion** off. The clips must be in place.

### 11.3 Point a move or attack at a new clip

- **Player attack:** select `Player ▸ Weapons ▸ Weapon_… ▸ Light1` (or `Heavy`, …). In **Scripts**, set
  `clip`. Tune `playSpeed`, `range`, `arcDeg`, `staminaCost` and the `lunge*` fields to suit the motion.
- **Player one-shots:** select `Player` and set `rollClip`, `drinkClip`, `hitLightClip` and the other
  clip fields.
- **Enemy attack:** open the enemy's template (**Assets ▸ Templates ▸ Enemies**, double-click it), then
  select `Attacks ▸ <attack>` and set `clip`.
- **Add an attack:** duplicate an existing `Attacks` child and rename it. The enemy picks it up
  automatically. For the player, duplicate a move, rename it, and point the previous move's `next` at it.

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
2. Give the new model node a state machine that matches §6, using Animation mode on the node. The
   placeholder's machine on `Ch36` is the reference: three states and two triggers.
3. Delete the old `Ch36` node.
4. Keep the order of children. On the player, `camera rig` comes first and `Player Controller` last.
   On enemies, `Brain` stays last.
5. Re-fit the capsule in the **Physics** section on the character root if the new body is larger.
   On enemies, move `LockPoint` and `HealthAnchor`.
6. Re-attach weapons with **Attach to socket**. Each `Weapon` node's **Socket** must name a socket your
   rig has (§11.5).

**Only re-colouring?** Open the `(placeholder)` material from Assets and edit it. Every node using it updates.

### 11.7 Replace a weapon

1. Import the weapon model (§11.1).
2. Open the **Player** template. Under `Weapons ▸ Weapon_StraightSword ▸ Mesh`, delete the three placeholder
   boxes and drag your weapon model in as a child of `Mesh`.
3. Play, and adjust `Mesh`'s rotation and position until the grip sits in the hand. The weapon root
   cannot be moved while it is attached.
4. Tune the weapon's stats in its **Scripts** section: `displayName`, `baseDamage`, `strScaling`,
   `dexScaling`, the requirements, and `poiseDamage`.
5. **A third weapon:** in the Player template, duplicate a `Weapon_…` node. Weapon swap cycles every
   weapon in the group.

### 11.8 Level art

1. Import the level meshes and place them.
2. For every walkable or blocking surface, keep a collider: either an existing `Level` box (hide its
   mesh) or a new body in the **Physics** section.
3. Move the **Enemy Spawns** nodes. Each one's position and facing is where its enemy stands.
4. Move the `Fog Gate` so local +Z points into the arena. Set its `arenaCenter` and `arenaRadius` to cover
   the arena, on the placed copy (they become its overrides).
5. **Torches, messages, pickups:** place more by dragging the template from Assets into the viewport.
   Give a new message its text, and a new pickup what it gives, in the copy's Scripts section.
6. Re-bake the navmesh (§11.11).

### 11.9 Sounds

1. Drop the audio files on Assets, or use **+ Add ▸ Sound**. Set loop points on the music in the sample editor.
2. Select each node under `Sounds` and set **Sample**. Leave **Play on start** off, except on `Ambience`.

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

### Rules (`GameManager` → Scripts)

| Rule | Formula |
|---|---|
| HP | `400 + 30·(Vig−10)` up to Vigor 30, then +12 per point to 40, then +5 per point. |
| Stamina | `90 + 3·(End−10)` up to Endurance 40, then +1 per point. |
| Level cost | `400 + 120·(L−1) + 4·(L−1)²`. Level = 1 + every point spent. |
| Attack rating | `base × (1 + strScaling·bonus(STR) + dexScaling·bonus(DEX))`, ×0.6 if a requirement is unmet.<br>`bonus` is 0 at stat 10, 0.6 at 30 and 0.9 at 50. |
| Damage dealt | `max(1, AR × move.damageMul × (1 − defense))` |

### Weapons

| Weapon | Base | Scaling | Requirements | Poise |
|---|---|---|---|---|
| Straight Sword | 100 | STR 0.2 / DEX 0.8 | STR 8, DEX 10 | 15 |
| Greatsword | 165 | STR 1.0 / DEX 0.15 | STR 16 (starting STR is 10, so it begins penalised) | 32 |

| Moves | Stamina | Damage multiplier |
|---|---|---|
| Sword Light1 / Light2 / Light3 | 16 / 16 / 20 | 1.0 / 1.0 / 1.15 |
| Sword Heavy | 30 | 1.6 (poise ×2) |
| Greatsword Light1 / Light2 | 26 | 1.0 / 1.05 |
| Greatsword Heavy | 42 | 1.7 (poise ×2) |

### Enemies (template root → Scripts; attacks under `Attacks`)

| Enemy | HP | Defense | Poise | Souls | Notes |
|---|---|---|---|---|---|
| Hollow | 160 | 0 | 25 | 120 | **Swing** 70, **Sweep** 60; leash 18 m |
| Hollow Sorcerer | 110 | 0 | 15 | 160 | Keeps 7–14 m away; **Bolt** 90 at 12 m/s, 3.5 s cooldown; **Shove** up close |
| Elite Knight | 650 | 0.15 | 70 | 900 | **Sweep** 140; **Overhead** 190 with hyper armour; **Thrust** 150, lunging 4–9 m |
| Hollow Warden | 2600 | 0.2 | 150 | 6000 | Never flinches.<br>**Phase 1:** **Sweep** → **Backsweep** combo, **Slam** 220, **Lunge** 160.<br>**Phase 2** (≤50%): ×1.15 speed, adds **Leap** 200 (3.8 m AoE) and a 3-bolt **Bolt Fan**. |

**Shared fields:**

| Field | Default | Meaning |
|---|---|---|
| `engageRange` | — | Distance at which the enemy stops pathing and fights. |
| `preferredMin` / `preferredMax` | — | The spacing band the enemy holds while engaged. |
| `attackGapMin` / `attackGapMax` | — | Pause between attacks. |
| `flinchOnHit` | — | Whether ordinary hits make it flinch. |
| `poiseRegenDelay` | 3 s | Poise refills after this long without being hit. |
| `phase2At` | 0.5 | Boss phase-two threshold, as a fraction of HP. |
| `phase2SpeedMul` | 1.15 | Boss speed multiplier in phase two. |

**Brain fields** (on `Brain`): `perception.range` and `fieldOfView` set how far and how wide the enemy
can see you.

## 13. Regenerating the example, tests, limitations

The example folder `editor/public/examples/souls-demo/` is **generated**:

```
node tools/soulsDemo/build.mjs        # rebuild the folder (deterministic; re-runs are byte-identical)
npm --prefix editor run examples:list # refresh the gallery index
npx vitest run tests/soulsDemo        # rules + generated-project checks
```

- `tools/soulsDemo/build.mjs` holds the scene, templates, UI, materials and effects.
- `placeholderClips.mjs` holds the procedural stub animations, posed in character space.
- `inputMap.mjs` holds the bindings.
- Your art swaps happen in **your imported project**, not here. Edit the generator only to change what
  the example ships with.
- `tests/soulsDemoProject.test.ts` checks every name-based join: clips and their events, templates,
  sounds, widgets, input actions, sockets and child order. Run it after changing the generator.

**Known limitations:**
- **Placeholder clips are crude.** They exist for timing and events. The roll is an in-place somersault.
- **No root motion in actions.** One-shot clips must be in place; travel is scripted.
- **The navmesh ships unbaked** (§11.11).
- **Hits are arcs, not hitboxes.** Melee is resolved as range plus arc at the `hit` event, not by blade
  collision, because the engine has no overlap queries.
- **The player has no poise.** Every hit outside i-frames interrupts.
- **No blocking or parrying, and no inventory beyond the two weapons and the flask** — by design for this demo.
- **The level-up menu is keyboard/gamepad first.** The +/- and Confirm/Leave buttons also accept mouse clicks.
