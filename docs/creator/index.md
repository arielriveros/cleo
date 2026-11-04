# Cleo Creator

Cleo Creator is the procedural asset tool that ships beside the Editor. It runs the same engine as the
Editor and a published game, so a preview looks the way the asset will in play, and it is built from the
same app-kit (`applications/app-kit`): the same panels, docking, console, tooltips and renderer
settings.

It opens on its **home page**, which lists four tools as cards, the way the Editor's project launcher lists
projects. Click one to open it. While a tool is open, the top bar shows its name and a **Home** button
that goes back to the home page. A reload keeps the tool that was open; a new window starts at home.

| Tool | Makes | Exports |
|---|---|---|
| **World Creator** | Landscapes from landform layers and erosion | A 16-bit heightmap (PNG and RAW), slope/curvature/flow/wetness masks, and a JSON sidecar |
| **FX Creator** | Fire, smoke and explosions from a volumetric fluid simulation, or liquids (splashes, pours) from a particle one | A tileset flipbook (RGBA atlas PNG), a `.tileset` asset, and a JSON sidecar with the particle flipbook settings; for a liquid, its floor decal (an animated colour, normal and ORM atlas) |
| **Foliage Creator** | Grass clumps, bushes, trees and rocks from parameters, each with an LOD ladder and its materials | One `.glb` per level (textures embedded), impostor atlases for trees, and a JSON sidecar with the LOD distances |
| **[Motion Creator](motion.md)** | Character animation from a few key poses: eased in-betweens, overlapping action, IK-planted hands and feet | An `.anim.json` clip with its skeleton, and a JSON sidecar |

Open it from the Editor's menu bar (**Creator**), or run `npm run dev:all` at the repository root and go
to `http://localhost:8080/creator/`. It lives on the Editor's origin, under `/creator/`, so the two
share one asset library (see [Saved assets](#saved-assets)). `npm run creator:dev` still runs it alone, on
port 8081. The desktop app opens it as a second window. `npm run editor:dev` and `npm run desktop:dev` start
the Editor alone; to open the Creator from them, run `npm run creator:serve` alongside.

## Layout

Every tool is laid out the same way, so what you learn in one carries to the others:

- **Toolbar** — the tool's own controls on the left (kind, seed, the subject), then the
  [asset chip](#saved-assets), what is running on the right, and the tool's one output action at the far
  right: **Generate & export**, **Export flipbook**, **Download .glb** or **Download .anim**.
- **Left dock** — what is being built: the World's layers, the FX scene, the Motion's poses. Foliage has
  none.
- **Viewport** — the live preview. Numbers top-left; the **Stage** menu, the tool's controls and
  **Frame** top-right. **F** frames the asset in every tool.
- **Right dock** — **Parameters** first, with the preset name, **Reset** and **Presets ▾** at its top,
  then the tool's other tabs: Materials, LOD, Bake, Export, Parts.
- **Bottom** — **Assets** and the **Console**, with the World's **Map** and the Motion's **Timeline** beside
  them. Assets is the editor's own asset explorer, browsing the [saved assets](#saved-assets) of every tool
  under `/Foliage`, `/FX`, `/World`, `/Motion`, `/Characters` and `/Poses`: double-click one to open it in
  its tool; rename, duplicate, move into folders or delete it there. **+ Add ▸ Rigged character…**, or
  **Import** beside it, uploads a rigged model as a [character](motion.md#characters); **Import** also takes
  a `.motion.json` (the Motion Creator's sidecar) as a new motion. The toolbar is the Editor's: the same
  **+ Add** menu, opening upward, and the same **Import** button. Cards show a picture of the stage taken
  when the asset last changed.
- **Status bar** — the running job's progress and Cancel, or a summary of the last result.

### Stage

The **Stage** menu top-right of every viewport is the preview's stage, never part of the asset: **Show**
switches what the viewport draws (the grid, the floor, and the tool's own: the skeleton, the wind, the
FX region), **Sun** turns the sun (**Direction**) and raises it (**Elevation**), and a tool adds its own
sections below (Foliage's light, wind and weather).

## Saved assets

Each tool works on **Scratch** — its working document, kept in the browser — until **Save as asset…**
gives it a name. A saved asset is shared with the Editor: it appears in **every project** under
`/Creator/<Foliage|FX|World|Motion|Poses>/<name>`, and from then on every change you make here reaches the
Editor by itself, within a second or two. Nothing to export or import. The asset's name is the one name
there is: it is what the Editor calls the asset, and it names the files a Foliage or Motion download
writes (`untitled` on Scratch).

| Tool | Published when | Becomes, in the Editor |
|---|---|---|
| **Foliage** | Each rebuild (about a second after an edit). A tree's impostor is re-baked once edits pause for 3 s, and the previous one is kept until then. | A model with its LOD levels and cull distance, a material per part (Bark, Leaves…), and for a tree the octahedral impostor, which a foliage rule made from the model starts with. |
| **FX** | Each finished bake. With **Auto-bake** on, a saved asset re-bakes 1.5 s after an edit. | The flipbook (and six-way and motion maps) as textures, and a particle system drawing it. A liquid's floor decal comes as two decal materials: the settled pool, and its animated atlases; a decal using them stands at the sidecar's `outputs.decal.offset` from the effect's floor centre, `size` across. |
| **World** | Once edits pause for 2 s, at full resolution. | The heightmap and the masks as textures. A landscape imports the heightmap at full precision with **Import heightmap ▸ From Creator**, and offers **Re-apply** when the world changes. |
| **Motion** | Each re-bake (about a second after an edit), and when a library pose it uses changes. | An animation asset on its subject's rig. See [the Motion Creator](motion.md#in-the-editor). |
| **Pose** | As it is edited in the Motion Creator's Pose tab. | A Pose asset on its subject's rig. |

The toolbar's **asset chip** shows the asset being edited: click its name to rename it; its dot turns
green once the last change is saved; **✕** goes back to Scratch, which stops publishing (the asset stays in
the library) and keeps the document to go on from. Everything else is the **Assets** tab's: open an asset
there to edit it, and duplicate, move or delete it there. A Foliage asset also keeps the texture images
you loaded in its Materials tab, so reopening it restores them.

In the Editor, `/Creator` is read-only: renaming, moving or deleting there is refused, because the next
change from the Creator would undo it. Placed models, foliage rules and particle nodes that use a synced
asset update in place. To change one in the Editor, duplicate it into another folder. An asset deleted
in the Creator disappears from every project that does not use it; a project that does keeps it, in
`/Creator/Removed`.

## Determinism

Every asset is a pure function of its parameters and its seed. The sidecar written beside each export
records both, so the same file regenerates bit-for-bit on the CPU paths. The GPU paths agree with the
CPU to float rounding.

## GPU and CPU

The heavy passes (virtual-pipe erosion, the fluid solver) run as WebGPU compute on the engine's own
device when the renderer runs on WebGPU. On WebGL 2, which has no compute, the CPU reference
implementation runs instead: same method, same results within rounding, slower. Pick the graphics API
on the renderer settings, as in the Editor.

## Using the outputs in the Editor

[Saved assets](#saved-assets) need none of this. For files downloaded with the output action:

- **Heightmap:** in Landscape mode, import `world_height.png` (or `.r16`) and enter the **Min** and
  **Max** heights from `world.json` (`minHeight`, `maxHeight`). The masks import as paint layers.
- **Flipbook:** import `fx_flipbook.png` as a texture, then the `.tileset`; in a particle system's
  **Render** module set the texture to the tileset and copy `particleFlipbook` from `fx.json` into its
  flipbook settings (columns, rows, frames, FPS).
- **Foliage:** import every `*_LODn.glb` as a model (the materials arrive with their cutout,
  double-siding, translucency and wind already set), then on the LOD 0 model add LOD 1 and LOD 2 as
  its levels with the distances in `*.foliage.json`. Use the model in a foliage rule; bake its impostor
  there. See [Foliage Creator](foliage.md).
