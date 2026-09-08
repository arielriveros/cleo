# Audio

Sound is played by `SoundNode`s, which reference a **sound sample** asset. The sample owns the
loudness, loop points, fades, bus and effects; the node owns where it is and when it plays. Several
nodes referencing one sample means retuning one footstep retunes all of them.

Authoring is in [Audio (editor)](../editor/audio.md).

## Playing a sound

```ts
const sfx = this.findNode('Explosion') as SoundNode

sfx.play()
sfx.stop()
sfx.pause()
sfx.resume()
sfx.fadeTo(volume: number, seconds: number): void
sfx.get isPlaying: boolean
sfx.syncSpatial(): void
```

Node properties:

| Property | Meaning |
|---|---|
| `mode` | `'ambient'` (no position) or `'spatial'`. |
| `sampleId` | Which sample asset to play. |
| `volume` | Multiplier on the sample's own volume. |
| `loopMode` | `'inherit'` (follow the sample) / `'on'` / `'off'`. |
| `playOnStart` | |
| `spatial` | Distance model and falloff. |
| `distanceModel`, `refDistance`, `maxDistance`, `rolloffFactor` | Shortcuts into `spatial`. |

> `play()` is a **silent no-op** when `scene.soundsEnabled === false`. That is how the editor keeps
> a scene quiet while you author it — so a sound that does nothing in the viewport but works in Play
> is behaving correctly.

## One-shots

A sound node that plays and then despawns is usually cleaner than a pool:

```ts
public playAt(sampleId: string, position: vec3): void {
  const node = this.scene?.instantiate('Sfx One Shot', { position })
  if (!node) return
  const sound = node as SoundNode
  sound.sampleId = sampleId
  sound.play()
  node.after(5, () => node.remove())
}
```

Remember that the timer lives on the node it is scheduled on — here the one-shot itself, which is
fine because it survives long enough to fire.

## The listener

Placed automatically each frame from the active camera, in the audio pass **after** the camera-rig
pass, with every spatial emitter synced in the same pass. Both ends are therefore sampled at one
instant, which is what stops a rig-driven camera producing panning that lags by a frame.

You do not normally place it yourself, but you can:

```ts
AudioManager.Instance.setListener(position: vec3, forward: vec3, up: vec3): void
```

## The mixer

Four buses: `master`, `music`, `sfx`, `ui`.

```ts
const mixer = AudioManager.Instance.mixer

mixer.gain(bus: BusId): number
mixer.setGain(bus: BusId, v: number): void
mixer.muted(bus: BusId): boolean
mixer.setMuted(bus: BusId, m: boolean): void
mixer.get/set masterVolume: number
```

An options screen is a handful of sliders writing `setGain`:

```ts
onValueChanged(value: number) {
  AudioManager.Instance.mixer.setGain('music', value)
}
```

## Effects

Each sample can carry an **effect rack**: `filter`, `distortion`, `delay`, `reverb`, `compressor`.
Authored per sample in the editor; adjustable at runtime through `EffectRack`.

## The manager

```ts
AudioManager.Instance

get mixer: Mixer
get sounds: Map<string, Sound>
get hasWebAudio: boolean

getSound(id: string): Sound | undefined
getSource(id: string)
addSoundFromBytes(...) ; addSoundFromFile(...)
applySettings(id: string, settings: SoundSettings): void
removeSound(id: string): void
stopAll(): void
suspend(): void ; resume(): void
clear(): void
```

`hasWebAudio` is worth checking before building anything that assumes audio exists.

`suspend()` and `resume()` are the right pair for a tab-visibility handler or a pause menu that
should silence everything rather than duck it.

## A `Sound` directly

```ts
play(): number | null          // returns a voice id
stop(voiceId?: number) ; pause(voiceId?) ; resume(voiceId?)
isPlaying(voiceId?: number): boolean
seek(seconds: number, voiceId?: number)
fade(from: number, to: number, seconds: number, voiceId?: number)
setVoiceVolume(...) ; setVoicePan(...) ; setVoicePosition(...) ; setVoiceSpatial(...)
applySettings(next: SoundSettings): void
onLoad(fn: () => void): void
get duration / settings / source
```

Voice ids let you address one playing instance of a sample when several overlap.

## Attenuation

```ts
attenuationAt(distance: number, settings: SpatialSettings): number
```

Distance models: `'inverse'`, `'linear'`, `'exponential'`. Useful when you want a gameplay value —
how loudly a guard could have heard something — to match what the player hears.

## See also

[Audio (editor)](../editor/audio.md) · [Scene and game](scene-and-game.md)
