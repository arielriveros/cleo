# Sequencer *(unreleased)*

A **Sequence** node plays a cinematic: a timeline of tracks that fly a camera along a path, cut between
cameras, animate properties of other nodes and call script methods at given moments. The **Sequencer**
panel in the bottom strip edits the timeline of the selected Sequence node and previews it in the scene.

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

Tracks hold **sections**: spans of time that own their keys, so moving a section moves its animation. A
section eases in over whatever value was there before it, and **When finished** decides whether its target
keeps the last value or goes back to what it was.

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
  - the ruler scrubs, and its flags are markers.
- **Details:** what is selected, editable. A path section lists its points: **Add from viewport** appends
  the editor camera's position, and **View** moves a point there. A property section lists its keys:
  **Key current value** adds a key at the playhead holding what the target shows now. A preset section
  picks the preset it blends to and where it starts from; a foliage section keys each channel (**Key**
  adds one at the playhead), and the Foliage track's details pick its layers.

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

## Export and import

**Export** saves the sequence as `<name>.sequence.json`, and **Import** replaces it with one. The Valley's
tour is kept in that format in `tools/valley/cinematic/valley-tour.sequence.json`, so a tour retimed here
exports straight over it, and `tools/valley/applyCinematic.ts` puts it into the example.

## See also

- [Sequences in scripts](../scripting/scene-and-game.md#sequences): `Game.playSequence`, `play()`, `stop()`,
  events and the director.
- [Node inspector: Sequence](node-inspector.md#sequence).
