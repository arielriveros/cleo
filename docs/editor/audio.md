# Audio

Sound is split in two: a **sound sample** asset carries how something sounds, and a **Sound node**
carries where and when it plays.

That split is deliberate — several nodes referencing one sample means retuning one footstep retunes
every footstep in the game.

## Sound samples

Import an audio file (`.wav`, `.mp3`, `.ogg`, `.m4a`, `.flac`, `.aac`, `.opus`, `.webm`) by dropping
it on the Assets panel, or create a sample with **+ Add ▸ Sound**.

Opening a sample gives you a waveform with a transport and a loop region, plus:

| Setting | Meaning |
|---|---|
| **Name** | |
| **Volume** | The sample's own loudness. |
| **Loop points** | Start and end of the looped region, dragged on the waveform. |
| **Fades** | Fade in and out. |
| **Bus** | Master, Music, SFX or UI. |
| **Effect rack** | Filter, distortion, delay, reverb, compressor. |

Loop points matter for music: a track that loops at an arbitrary boundary clicks, and a track that
loops at the right one does not.

## Sound nodes

Add **Audio ▸ Spatial Sound** or **Ambient Sound**. An ambient sound is not placeable — it has no
position.

| Setting | Meaning |
|---|---|
| **Mode** | Spatial or ambient. |
| **Sample** | Which sample asset to play. |
| **Volume** | A multiplier **on top of** the sample's own volume. |
| **Loop mode** | *Inherit* (follow the sample), *On*, or *Off*. |
| **Play on start** | |
| **Distance model** | Inverse, linear or exponential. |
| **Reference distance** | Where attenuation begins. |
| **Max distance** | |
| **Rolloff factor** | How steeply it falls off. |

Spatial emitters are drawn in the viewport when **Sound emitters** is on in the debug eye menu,
which is the only practical way to see falloff spheres while placing them.

## Buses

Four: **Master**, **Music**, **SFX**, **UI**. Every sample is assigned to one, and a game's options
screen is a handful of sliders writing to their gains:

```ts
AudioManager.Instance.mixer.setGain('music', value)
```

## Effects

Each sample can carry an effect rack: `filter`, `distortion`, `delay`, `reverb`, `compressor`.
Because the rack is on the *sample*, every node playing it inherits the effect — the right place for
"this radio always sounds like a radio".

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
