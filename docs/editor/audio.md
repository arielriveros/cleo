# Audio

Sound is split in two: a **sound sample** asset carries how something sounds, and a **Sound node**
carries where and when it plays.

That split is deliberate — several nodes referencing one sample means retuning one footstep retunes
every footstep in the game.

## Sound samples

Import an audio file (`.wav`, `.mp3`, `.ogg`, `.m4a`, `.flac`, `.aac`, `.opus`, `.webm`) by dropping
it on the Assets panel, or create a sample with **+ Add ▸ Sound**.

Opening a sample gives you a waveform with a transport and a loop region, and the sample's settings
in Properties, from its source down to its [effect rack](#effects).

### Source

The audio file the sample reads, with its length and size. A sample whose file has gone missing keeps
its settings; one registered at runtime has no file in the project behind it.

### Level

How loud the sample is, where it sits between the speakers, and how fast it plays.

- **Volume** — the sample's own gain. A Sound node multiplies its own volume on top of this.
- **Pan** — stereo position. Ignored by a spatial Sound node, whose panner owns the stereo field.
- **Rate** — playback speed, 0.5–4×. Pitch follows it: there is no time-stretch.

### Looping

Whether the sample repeats, and between which points. **Loop** turns it on; the points are the region
handles dragged on the waveform, or typed here. A region takes effect on the next play, because a
buffer's loop points are read when it starts.

- **Start** — where the loop begins, in seconds.
- **End** — where it ends, in seconds; 0 means the end of the file.

Loop points matter for music: a track that loops at an arbitrary boundary clicks, and a track that
loops at the right one does not.

### Fades

A ramp up from silence when the sample starts (**In**) and down to silence when it stops (**Out**),
in seconds; 0 is off. A stop waits for the fade-out to finish.

### Routing

Where the output goes, and when the sample is decoded.

- **Bus** — where the sample's output is mixed: **Master**, **Music**, **SFX** or **UI** (see
  [Buses](#buses)).
- **Preload** — decode at load rather than on first play, for a sound that must not be late. It
  applies on the next load: in the editor the sample is already decoded.

## Sound nodes

A Sound node plays a sample from somewhere in the scene: what this emitter does, never what the
sample sounds like. Add **Audio ▸ Spatial Sound** or **Ambient Sound**. An ambient sound is not
placeable — it has no position.

| Setting | Meaning |
|---|---|
| **Sample** | Which sample asset to play: picked, imported, or dropped from the Assets panel; ✎ opens it in the sample editor. With none, the emitter is silent. |
| **Mode** | **Spatial** emitters are placed in the world and attenuated by distance from the listener; **Ambient** ones are heard at a constant level wherever the listener is. |
| **Volume** | A multiplier **on top of** the sample's own volume. |
| **Loop** | **Sample** follows the sample's own loop setting; **On** or **Off** overrides it for this emitter only. |
| **Play on start** | Start automatically when the scene begins playing. |

Sounds are silent while you author: press **Play** in the toolbar to hear the scene, or audition one
emitter with **▶ Play** in its inspector.

### Falloff

How a spatial sound's volume drops with distance — ambient sounds have none. The curve under the
settings is drawn from the same formulae the audio engine uses, so what is plotted is what is heard;
**Presets** cover the common cases, from a small prop to a distant event heard across the map.

| Setting | Meaning |
|---|---|
| **Distance model** | Inverse, linear or exponential: how volume drops with distance. |
| **Reference** | Full volume within this radius; it gets no louder closer in. |
| **Max** | Linear falls silent here; the other models only clamp at it. |
| **Rolloff** | How steeply it falls off. 0 is no attenuation at all. |

Sound emitters show an icon in the viewport when **Sound emitters** is on in the debug eye menu. A
spatial emitter's falloff sphere (drawn at **Max**) appears only while that emitter is
selected.

## Buses

Four: **Master**, **Music**, **SFX**, **UI**. Every sample is assigned to one, and a game's options
screen is a handful of sliders writing to their gains:

```ts
AudioManager.Instance.mixer.setGain('music', value)
```

## Effects

Each sample can carry an effect rack — `filter`, `distortion`, `delay`, `reverb`, `compressor` — run
top to bottom, so order matters: a filter before a distortion is not the same patch as one after it.
Because the rack is on the *sample*, every node playing it inherits the effect — the right place for
"this radio always sounds like a radio".

Each insert can be bypassed, moved or removed, and keeps its settings while bypassed. Effects need
Web Audio; a device that falls back to HTML5 audio plays the sample dry.

## The listener

Placed automatically from the active camera, every frame, in the audio pass **after** the camera-rig
pass — so a rig-driven camera's panning is sampled at the same instant as its position rather than
lagging by a frame. There is nothing to set up.

## Playing from script

```ts
const sfx = this.findNode('Explosion') as SoundNode
sfx.play()
sfx.fadeTo(0, 1.5)
```

Full API: [Audio (scripting)](../scripting/audio.md).

> **Sound is silent while you author.** `play()` is a no-op when the scene's sounds are disabled,
> which is how the editor keeps a scene quiet while you work in it. A sound that does nothing in the
> viewport but works in Play is behaving correctly.

## Publishing

Audio sources and sound samples are carried **explicitly** in a project bundle rather than
re-derived, because loop points, fades, bus assignment and effect racks cannot be recovered from a
`.wav`.

## See also

[Audio (scripting)](../scripting/audio.md) · [Assets](assets.md) · [Node inspector](node-inspector.md)
