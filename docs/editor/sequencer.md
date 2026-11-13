# Sequencer *(unreleased)*

A **sequence** is a cinematic: a timeline of tracks that fly a camera along a path, cut between cameras,
animate properties of other nodes, play clips and sounds, spawn templates, hand characters to controllers and
call script methods at given moments or over spans of time. It is an asset (`.sequence`), and a **Sequence**
node plays it in a scene.

## Sequence assets

Create one from the Assets tab's **+ Add ▾ Sequence**: it opens in Sequencer mode at once. To play it in a
scene, drop it from the Assets tab into the viewport, which adds a Sequence node playing it, or drop it on a
Sequence node's **Timeline** slot.

A Sequence node keeps its own copy of the sequence it plays, the way a Particle System node keeps its effect:
a published game needs no sequence library. Saving the asset updates every node in the open scene that plays
it (the scene is then marked unsaved), and a scene opened or published later picks up the saved version.
Deleting the asset leaves each node playing the copy it has; only the link goes.

On the node's card, **✎** opens the asset in Sequencer mode, **✕** unlinks it, and an unlinked node's **Edit in
Sequencer** turns its copy into an asset first.

## Sequencer mode

Opening a sequence asset (double-click it in the Assets tab, or **✎** on a Sequence node) opens it in a tab of
its own, in **Sequencer mode**. The mode works on the scene you have open, live: the same viewport, the same
scene tree and the same node inspector as Scene mode, with the **Sequencer** panel along the bottom. Its panel
headers are light orange, so it is never mistaken for Scene mode.

**Every change you make to a node there is a key**, at the playhead. Move a cube with the gizmo at 2 s and
the sequence gets a key at 2 s with the new position, plus a key at 0 s with where the cube was: it now moves
from one to the other over those two seconds. The same goes for any property the inspector shows (a light's
intensity, a camera's field of view, a script field) and for the scene tree's visibility eye. The scene itself
does not change: go back to the scene tab and the cube is where you left it.

The first key of a property makes its track, on a slot bound to the node (the slot is made too, named after
the node). Later keys land on that track: on the section under the playhead, or on the nearest section,
stretched to reach the key. A turn past 180° keys the shortest way round from where it was.

What can't be a key isn't offered in Sequencer mode: the Add palettes, Scripts and Physics panels are gone,
the scene tree only selects (no rename, move or delete), asset slots (materials, effects, brains, sounds) are
disabled, and nothing can be dropped into the scene. A position or rotation a Path track already drives can't
be keyed either; move the path's points instead.

### Keys

The **Keys** card heads the inspector in Sequencer mode. It lists what the sequence animates on the selected
node, with a filled diamond where there is a key at the playhead, the value the node shows now, jumps to the
previous and next key, and **✕** to delete the key at the playhead. **Key property…** keys the current value of
any property the sequence can drive, including ones no inspector field shows.

A key inside a section's ease, or under another section, is noted: there the frame blends, so it shows less
than the value keyed.

**Save** (Ctrl+S) writes the asset. Each Sequencer tab keeps its own unsaved changes while you work in other
tabs, and **Undo** in a Sequencer tab undoes its keys and edits, one step each. **Play** from a Sequencer tab
plays the scene with the sequence as you have it, saved or not.

## Slots, tracks and sections

A sequence never names a node directly. It names **slots** ("Camera", "Sun"). A slot is bound to the
node it was authored against (in the slot's details, by dropping a node from the scene tree on the outliner,
or by keying it), and falls back to the node its name path finds in another scene. A Sequence node can bind a
slot to another node of its scene on its inspector card, which wins over both: so one sequence can drive other
actors.

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
  to it (or to select its slot, when it has one).
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

Scrubbing or playing shows the sequence in the open scene: the camera on its path, the properties at their
values, the inspector reading them at the playhead. It is only a preview: the scene tab shows the scene as
authored, and saving, Play, Simulate and switching tabs or 2D/3D put the scene back before anything reads it.
**Stop** goes back to the start.

The viewport keeps the editor camera while you preview. **Pilot** looks through the shot's camera
instead, and puts the editor camera back where it was when you turn it off.

Scripts do not run while you edit, so a property track on a script field changes only the field, and what
the script makes of it shows only in Play. Key the nodes themselves instead: the Valley's day keys the Sun's
rotation, colour and lux, the Sky Light, the sky's mist and god rays and the fog volumes, so scrubbing moves
the sun and light probes set to **Follow the sun** relight as it turns. UI the sequence animates (a
letterbox, a fade) shows in the viewport with the **Game UI** overlay on.

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

## Render Movie

**Render…** on the toolbar renders the sequence to a movie: an MP4, or a folder of PNG frames. It plays the
scene as **Play** would (scripts, physics, particles, the sequence as you have it, saved or not), but
**offline**: every frame is exactly one frame-length of the game after the last, however long it takes to
draw. A frame that takes ten seconds shows the same as one that takes ten milliseconds, so the movie never
stutters, whatever the machine.

- **Resolution** — the frame's size, a preset or **Custom** (a video frame needs an even width and height).
  It has nothing to do with the viewport's: a 4K movie renders on a small screen.
- **Frame rate** — frames per second. 23.976, 29.97 and 59.94 are held exactly (24000/1001 and so on).
- **Range** — the sequence seconds to film, the whole sequence by default. A start past 0 is jumped to, so
  event keys before it do not fire.
- **Samples** — renders averaged into each frame. Each is shifted by a fraction of a pixel, which
  anti-aliases the frame better than TAA can; with a shutter they are also spread through the frame's
  time, which is real motion blur. **1** renders the frame as Play shows it (its own TAA and motion blur).
- **Shutter** — how much of each frame's time the samples spread over, in degrees: 180 blurs half a frame's
  movement, as a film camera does; 0 turns motion blur off; 360 blurs all of it.
- **Pre-roll** — seconds the scene runs with the sequence held at its start before the first frame, for
  particles, cloth or rain that need time to fill in.
- **Cinematic quality** — raise every setting that only costs time: resolution scales to full, the Ultra
  tier's clouds, more SSAO, SSR and fog samples, larger shadow maps, GI and probes converged before every
  frame, shadows never staggered. The project's look — exposure, tone curve, grading, which effects are on,
  draw distances — is never changed.
- **Sound** — record what plays and mix it into the movie: sequence audio tracks, sound nodes and script
  sounds, through their effects, buses and 3D placement. An MP4 gets AAC (or Opus); PNG frames get a
  24-bit WAV beside them.
- **Format** — **MP4**, or **PNG frames** (lossless, `name_000000.png`…, for grading or editing elsewhere).
- **Codec** — the video codecs this machine can encode at this size and rate: H.264 plays everywhere; HEVC,
  AV1 and VP9 are smaller at the same quality.
- **Quality** — **Maximum** is near-transparent, **High** is smaller, **Custom** sets the codec's quantizer
  (lower is better). Every frame is encoded to the same quality, not the same size.

Before the first frame the light is settled (GI, light probes and the sky converged, the exposure metered),
and before every frame each program it needs is built and each texture loaded: nothing pops in. The game UI
is drawn into the frames at the movie's resolution; a world-space panel seen in perspective is the one thing
left out. While the render runs the editor is busy: the dialog shows the latest frame, how far it has got and
how long is left. **Cancel** keeps the frames rendered so far as a shorter, valid movie.

A game that starts its cinematic from a menu of its own can see what is being filmed in `Game.movieRender`
([Sequences in scripts](../scripting/scene-and-game.md#movies)); the Valley's start menu goes straight into
the tour when the tour is rendered.

It takes as long as it takes: samples x frames renders. The Valley's tour at 1080p, 30 fps and 16 samples
is about 190,000 renders. Leave the desktop editor rendering in the background; a browser tab must stay
visible, or the browser slows it down.

## Export and import

**Export** saves the sequence as `<name>.sequence.json`, and **Import** replaces the asset's timeline with one
(an undoable edit, saved with the asset). The Valley's tour is kept in that format in
`tools/valley/cinematic/valley-tour.sequence.json`, so a tour retimed here exports straight over it, and
`tools/valley/applyCinematic.ts` puts it into the example as the `Valley Tour.sequence` asset.

## See also

- [Sequences in scripts](../scripting/scene-and-game.md#sequences): `Game.playSequence`, `play()`, `stop()`,
  events and the director.
- [Node inspector: Sequence](node-inspector.md#sequence).
