# Reference — file formats

Asset extensions, the project bundle, and the published-game container. You rarely need this to
make a game; you need it to understand what an export contains, why an old bundle still opens, and
what a version number is guarding.

---

## Asset extensions

Two kinds keep the real extension of the file their bytes arrived as; every other kind carries a
**virtual** extension, because it is an authored record rather than a file.

| Kind | Extension | Notes |
|---|---|---|
| `image` | `.png` `.jpg` `.jpeg` `.bmp` `.tga` `.webp` `.tiff` `.gif` | Raw bytes. |
| `audioSource` | `.wav` `.mp3` `.ogg` `.m4a` `.flac` `.aac` `.opus` `.webm` | Raw bytes. |
| `texture` | `.tex` | An image **plus sampling settings**. |
| `soundSample` | `.sound` | An audio source plus loop points, fades, bus and effects. |
| `material` | `.mat` | |
| `terrainMaterial` | `.tmat` | |
| `template` | `.tpl` | A prefab. |
| `model` | `.model` | |
| `scene` | `.scene` | |
| `script` | `.script` | |
| `animationField` | `.afield` | A blend space. |
| `animation` | `.anim` | A shared clip, in its source rig's space. |
| `tileset` | `.tileset` | |
| `aiBrain` | `.brain` | *(unreleased)* |

The extension is everything after the **last** dot. Renaming an asset keeps its kind — the
extension is re-applied, not re-read.

> The image/texture split is worth knowing: a texture is not its image file. One image can back
> several textures with different wrap, filter, mipmap and colour-space settings, and the image sits
> in a `Source/` subfolder underneath.

---

## Project bundle — `.zip`

What **Export** writes and **Import** reads: every scene, all asset libraries, the virtual folder
layout, project preferences and all texture and audio payloads.

`BUNDLE_FORMAT_VERSION = 2`. Format 2 moves every bulk payload into a single **`assets.bin`** —
texture bytes, mesh geometry, joint attributes, skins, animation samplers, terrain height and splat
data, foliage instances, tilemap cell grids, skybox faces and thumbnails — leaving the JSON entries
otherwise unchanged, so an inflated v2 bundle reads like a v1.

**Format 1 is still readable.** The reader branches on `manifest.formatVersion`, which is what keeps
old exports and the shipped example projects importable.

Two bundle kinds exist: `'project'` (carries `mainSceneId`, `openSceneId`, `sceneMetas`, `prefs`,
`projectName`) and `'assetpack'`.

Audio sources and sound samples are carried **explicitly** rather than re-derived, because loop
points, fades, bus assignment and effect racks cannot be recovered from a `.wav`. Images and
textures *are* re-derived on import.

Importing offers three outcomes: **New project**, **Replace**, or **Merge**. Merge re-mints
colliding ids and remaps the references that point at them.

---

## Published game — `game.bin`

What **Publish** writes alongside `index.html` and `game.js`.

- Magic `CLEOPAK1`, `PACK_VERSION = 1`.
- A 4-byte-aligned chunk blob with a JSON manifest.
- Typed arrays map straight onto the downloaded buffer with no parse step.

`PACK_VERSION` governs the **container layout** and stays at 1 so old bundles keep loading.

### Player contract

A **second, orthogonal** version number: `PLAYER_CONTRACT`. It governs whether the player
*understands* what the packer emitted, and it exists because ignoring an unknown manifest field
degrades **silently** — flat terrain, a missing HUD, characters stuck in bind pose, no logging at
all. Bump it whenever the packer emits something an older player cannot read.

It is enforced at three points: the player build stamps it into `build.json`; publishing refuses
when the built player's number does not match; and the player refuses to boot a `game.bin` whose
manifest contract is newer than itself.

| Contract | Added |
|---|---|
| 1 | Pre-guard bundles (no `build.json`) |
| 3 | Tilemap cell chunks |
| 4 | UI nodes in the scene tree |
| 5 | Game-level shared animation clips |
| 6 | Skinned joint indices and weights moved to blob chunks |
| **7** | `NavMeshNode` *(unreleased — a v6 player has no such class, so `scene.navMeshes` comes back empty and path/patrol agents walk into geometry)* |

### What a build strips

- **Editor-only nodes** — the grid, gizmos, light icons, collision wireframes, the navmesh preview.
  These are structurally absent, not merely hidden.
- **The unused dimension.** A 2D build discards 3D authoring data and a 3D build discards the 2D
  data. The ordering of this step matters and is why switching a scene's dimension warns first.
- **Unreferenced textures.** Only textures something actually points at are shipped.
- **The AI brain library.** Brains are embedded on their controllers, so a published game contains
  no brain assets — see [AI brains](../editor/ai-brains.md).

Scripts are extracted and obfuscated, and terrain data is DEFLATE-compressed.

---

## Version numbering

The product version is `1.x.y.z`:

| Component | Counts |
|---|---|
| `1.` | Fixed product-line prefix. |
| `x` | Breaking changes. |
| `y` | Major features. |
| `z` | Fixes and refactors. |

`package.json` stores only `x.y.z`, because npm requires three-component semver; the engine's own
`VERSION` constant carries all four. A CI check keeps the two representations from drifting.

The changelog is generated from the description of the pull request whose merge cut the release, so
the release notes on GitHub and [`CHANGELOG.md`](../../CHANGELOG.md) cannot disagree.

## See also

[Assets](../editor/assets.md) · [Publishing](../editor/publishing.md) · [Projects](../editor/projects.md)
