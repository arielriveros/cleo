# Sequencer *(unreleased)*

A **Sequence** node plays a cinematic: a timeline of tracks that fly a camera along a path, cut between
cameras, animate properties of other nodes, play clips and sounds, spawn templates, hand characters to
controllers and call script methods at given moments or over spans of time. The **Sequencer** panel in the
bottom strip edits the timeline of the selected Sequence node and previews it in the scene.

Add a sequence from **Add ▸ Gameplay ▸ Sequence**, or with **Add Sequence** in the empty Sequencer. Select
it to show its timeline; **Open in Sequencer** on its inspector card brings the panel forward.

## Slots, tracks and sections

A sequence never names a node directly. It names **slots** ("Camera", "Time of Day"), and the Sequence
node binds each slot to a node in the scene, on its inspector card or in the slot's details. A slot with no
binding looks for the node its fallback path names. So one sequence can drive other actors, and a copied
subtree's sequence drives the copies.

| Track | What it does |
|---|---|
| **Path** | Moves its slot's node along a smooth path through its points, at constant speed or eased, looking ahead, at a point, at another node or along a second path. A camera also takes the section's roll and field of view. |
| **Camera cut** | Which slot's camera the game looks through. A sequence has one; each section is a shot. |
| **Property** | Animates a dotted path on a slot's node (`opacity`, `camera.fov`, a script field such as `hour`), on the renderer's settings (`ssrMaxDistance`), or on the game (`timeScale`). Numbers and vectors interpolate; text and on/off values step. |
| **Events** | Keys that call a method at a moment: on the Sequence node's own script (the director) or on a slot's node. They fire as playback passes them, never on a scrub. |
| **Presets** | Blends a Volumetric Clouds, Wind or Weather node into one of its own presets (the ones its inspector's **Presets** menu applies) over each section, eased. A section starts from its **From** preset, else from where the section before it ended, else from the node as the sequence found it: a row of sections morphs the sky from Clear to Thunderstorm and back. Numbers and colours blend; a kind switches halfway. |
| **Foliage** | Changes a landscape's foliage layers live (all of them, or the ones ticked): **Density** thins them, **Draw distance** and **Impostor distance** bring their distances in, as multipliers on each layer's own (1 = as authored), and **Shadows** switches their shadow casting. A thinned layer draws a share of every cell, spread evenly and nested, so going from 0.1 back to 1 fills the field in without one plant swapping for another; what is thinned out of sight no longer collides either. |
| **Script** | Calls a method of the director (the Sequence node's own script) or of a slot's node over each section: as it is entered, every frame inside it and as it is left. A section can hold the playback at its end until the script lets it go. See [Script tracks](#script-tracks). |
| **Animation** | Plays a clip on a slot's animator over each section, as an action over whatever its controller does, its clip time locked to the timeline. See [Animation tracks](#animation-tracks). |
| **Audio** | Plays a slot's Sound node over each section, from an offset into its sample, at a keyed volume. See [Audio tracks](#audio-tracks). |
| **Spawn** | Instantiates a template over each section and removes it after, optionally filling a slot so the other tracks drive the new node. See [Spawn tracks](#spawn-tracks). |
| **Possess** | Makes a slot's controller possess the character in another slot over each section, and hands back what it had after. See [Possess tracks](#possess-tracks). |

Tracks hold **sections**: spans of time that own their keys, so moving a section moves its animation. A
section eases in over whatever value was there before it, and **When finished** decides whether its target
keeps the last value or goes back to what it was.

**+ Track** lists the sequence's own tracks (Camera cut, Events, Director script, Spawn, a renderer or game
property), then, under each slot, what its node can take: Path, Property and Script on any node; Presets on a
node with a preset list; Foliage on a landscape; Animation on a node with an animator, its own or a model's
below it (a character); Audio on a Sound node; Possess on a controller. An unbound slot (one a spawn fills,
say) is judged by its **Node type**: `model` or `character` for Animation, `sound` for Audio, `controller`
for Possess.

## The panel

- **Toolbar:**
  - transport: to the start, a frame back, play / pause, a frame forward, to the end, stop, loop;
  - the time;
  - **Pilot**, **Snap** and zoom;
  - **+ Track**;
  - **Export** and **Import**.
- **Outliner:** one group per slot with its tracks under it, then the sequence's own tracks. Right-click a
  slot or a track for its actions. Drop a node from the scene tree onto the outliner to add a slot bound
  to it.
- **Lanes:**
  - drag a section to move it, its edges to trim it, and the white corners at its top to set its ease
    in and ease out;
  - property keys are the diamonds inside a section, and event keys the diamonds on an event row; drag
    either to retime it;
  - double-click an empty lane to add a section (or an event);
  - right-click a section to split, duplicate or delete it;
  - a script section that holds shows a pause sign at its end;
  - the ruler scrubs, and its flags are markers.
- **Details:** what is selected, editable. A path section lists its points: **Add from viewport** appends
  the editor camera's position, and **View** moves a point there. A property section lists its keys:
  **Key current value** adds a key at the playhead holding what the target shows now. A preset section
  picks the preset it blends to and where it starts from; a foliage section keys each channel (**Key**
  adds one at the playhead), and the Foliage track's details pick its layers. Script, animation, audio,
  spawn and possess sections are described under [Gameplay tracks](#gameplay-tracks).

Every edit is one undo step; a drag records once, when you let go.

| Key | |
|---|---|
| **Space** | Play or pause the preview. |
| **J / K / L** | Back a second / pause / play. |
| **, .** | A frame back / forward. |
| **Home / End** | The start / the end. |
| **S** | Split the selected section at the playhead. |
| **M** | Add a marker at the playhead. |
| **Delete** | Delete what is selected. |
| **Ctrl+D** | Duplicate the selected section after itself. |
| **Ctrl+wheel** | Zoom about the pointer. |

## Previewing

Scrubbing or playing shows the sequence in the scene you are editing: the camera on its path, the
properties at their values. The **previewing** tag in the toolbar means the scene currently differs from what you
authored. **Stop** puts it back. So do saving, Play, Simulate, switching tabs or 2D/3D, opening another
scene, selecting another node and grabbing a gizmo, so a preview is never saved.

The viewport keeps the editor camera while you preview. **Pilot** looks through the shot's camera
instead, and puts the editor camera back where it was when you turn it off.

Scripts do not run while you edit, so a property track on a script field changes only the field: the
Valley's time-of-day track moves `hour`, and the sun follows it only in Play. UI the sequence animates
(a letterbox, a fade) shows in the viewport with the **Game UI** overlay on.

For the same reason a script track calls nothing while you preview, and a spawn track spawns nothing (the
scene being edited is not a game's): both are authored here and do their work in Play. The editor also keeps
the scene's sounds quiet, so an audio track is heard in Play only.

## Gameplay tracks

### Script tracks

A script section calls one method with a context ([The director](#the-director) lists it): with `phase`
`'enter'` as the playback enters the section, `'update'` on every frame inside it after that, and `'exit'` as
it leaves, on a stop too. A section the playback passes within one frame still gets its enter and its exit; a
seek or a scrub that jumps over it calls nothing.

- **Calls** — on the track: whose script the sections call, the director's (the Sequence node's own) or a
  slot's node's.
- **Method** — the method's name. A new section calls `onSequenceSection` until you rename it.
- **Arguments** — a JSON array (`[1, "two"]`), passed on in `ctx.args`.
- **Hold at the end** — the playback stops at the section's end, holding the frame, until the method calls
  `ctx.resume()` (or a script calls the Sequence node's `resume()`). A seek away leaves the hold behind.

A script section has no **When finished**: its method is told when it is left. Splitting one gives both
halves the method and its arguments, and a hold stays on the second half, so the playback still waits at
the same place. Scripts run in Play only.

### Animation tracks

Plays clips on the slot's animator, its own or the first one below it (a character's model), as an action:
over whatever its controller does, faded in over the section's ease in and out over its ease out (0.15 s and
0.2 s when they are unset). The clip time follows the timeline: exactly on a seek, and corrected while
playing when it drifts, so the clip's own events still fire.

- **Action slot** — on the track: the animator's action slot the clips play in, `Sequence` when empty. A
  masked slot (an upper-body one the controller declares) keeps the legs on locomotion.
- **Clip** — picked from the animator's clips, or typed when the editor sees none (an unbound slot, one a
  spawn fills).
- **Clip start** — clip seconds at the section's start.
- **Speed** — clip seconds per sequence second.
- **Loop** — wrap the clip rather than hold its last frame.

When the timeline leaves a section the clip fades out; with **When finished** set to keep it plays out on its
own. Splitting a section starts the second half's clip where the cut is (**Clip start** + the seconds into
the section × **Speed**), and trimming a section's start skips that much of the clip, so nothing moves on
screen.

### Audio tracks

Plays the slot's Sound node over each section, from **Offset** seconds into its sample, at the sequence's
own speed. Its volume is the node's own times the section's eases times the **Volume** keys: 0 to 1, full
when there are none (**Key** adds one at the playhead; deleting the last key takes the volume away). A seek
joins the sample at the moment the timeline is at. When the timeline leaves a section the sound stops; with
**When finished** set to keep it plays on.

Splitting a section starts the second half's sample at the cut (**Offset** + the seconds into the section),
the volume keys split like any curve; trimming the start skips that much of the sample. Sounds stay quiet
while you edit, so an audio track is heard in Play only.

### Spawn tracks

A track of the sequence's own. Each section instantiates a template while it is in, the way
`scene.instantiate` does, and removes the node when the timeline leaves it; with **When finished** set to
keep, the node stays, and is the scene's from then on.

- **Template** — picked from the project's templates.
- **Name** — the new node's name; the template's own when empty.
- **Parent** — spawn under this slot's node instead of at the scene root.
- **Fills slot** — the slot the new node fills while it lives, so the sequence's other tracks (a path, an
  animation, a possession) drive it. The outliner shows such a slot as *(spawned)*.
- **Position** and **Rotation** — where it appears (in the world, or local to the parent) and its Euler
  angles in degrees; the template's own when unset. **Set from viewport** puts the position at the editor
  camera (in the parent's space when there is one), and × goes back to the template's own.

A spawn track spawns nothing while you edit, and a section the playback passes within one frame spawns
nothing either. Splitting a section makes two spawns, one after the other.

### Possess tracks

On a controller's slot. Over each section the controller possesses the character in the **Pawn** slot
(characters are listed first); when the timeline leaves the section, or on a stop, the controller gets back
the pawn it had, or lets go. With **When finished** set to keep, it keeps the new one. Deleting the pawn's
slot deletes its possessions.

## The director

The Sequence node's own script is the cinematic's director: event keys and script tracks that name no
slot call its methods (a slot's node is called the same way). A script section's method receives a
`SequenceScriptContext`:

| Field | |
|---|---|
| `phase` | `'enter'`, `'update'` or `'exit'`. |
| `time` | Sequence seconds. |
| `local`, `duration` | Seconds into the section, and its length. |
| `alpha` | `local / duration`, 0 to 1. |
| `weight` | The section's ease in and ease out ramp, 0 to 1. |
| `dt` | Sequence seconds since the last call: 0 on entering, and on a seek. |
| `seeking` | The timeline jumped here (a seek or a scrub) rather than played here. |
| `stopped` | On `exit`: the playback was stopped, and the scene is being put back, rather than time moving on. |
| `args` | The section's **Arguments**, or an empty array. |
| `sequence` | The Sequence node playing. |
| `resume()` | Let a hold section go: the playback carries on past its end. |

What a method changes is its own to put back: the sequence restores only what its tracks drove.

```ts
import { SequenceNode, UINode } from 'cleo'
import type { SequenceScriptContext } from 'cleo'

export default class IntroDirector extends SequenceNode {
  // A 3 s section calling showTitle: the card fades in and out with the section's eases, and is hidden after.
  showTitle(ctx: SequenceScriptContext) {
    const card = this.findNode('Title Card') as UINode
    card.opacity = ctx.phase === 'exit' ? 0 : ctx.weight
  }

  // A section calling waitForGate, with Hold at the end and Arguments [3]: the tour waits at its end until
  // the gate has had 3 s to open.
  waitForGate(ctx: SequenceScriptContext) {
    if (ctx.phase === 'enter' && !ctx.seeking) this.after(Number(ctx.args[0] ?? 2), () => ctx.resume())
  }
}
```

## Export and import

**Export** saves the sequence as `<name>.sequence.json`, and **Import** replaces it with one. The Valley's
tour is kept in that format in `tools/valley/cinematic/valley-tour.sequence.json`, so a tour retimed here
exports straight over it, and `tools/valley/applyCinematic.ts` puts it into the example.

## See also

- [Sequences in scripts](../scripting/scene-and-game.md#sequences): `Game.playSequence`, `play()`, `stop()`,
  events and the director.
- [Node inspector: Sequence](node-inspector.md#sequence).
