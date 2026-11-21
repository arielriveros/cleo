# Attribute types

An `@attribute` field's **type** decides what it is. The type also decides how the inspector edits the field, and
what the field holds while the game runs. Write `tint: Color` and you get a colour picker. Write `skin: Material`
and you get the material picker, with the Material itself at runtime. A node class such as `door: LightNode`
picks a node in the scene and holds that node. No decorator option is needed for any of these, and none
exists: the type is the whole declaration.

```ts
import { Node, Material, Texture, Sound, LightNode } from 'cleo'
import type { Color, ColorAlpha, Vec3, ClipName, SceneName } from 'cleo'
import { attribute } from 'cleo/decorators'

export default class Torch extends Node {
  @attribute flame: Color = [1, 0.6, 0.2]        // a colour picker; [r, g, b] at runtime
  @attribute offset: Vec3 = [0, 1.2, 0]          // X, Y, Z
  @attribute lit: Material = null                // the material picker; the Material at runtime
  @attribute crackle: Sound = null               // a sound sample; the Sound at runtime
  @attribute lamp: LightNode = null              // a light in the scene; that LightNode at runtime
  @attribute blowOut: ClipName = 'Extinguish'    // the clips of this node's character
  @attribute next: SceneName = 'Crypt'           // the project's scenes

  onStart() {
    if (this.lamp) this.lamp.castShadows = true
    this.crackle?.play()
  }
}
```

The engine's own nodes use the same types for their properties: a light's colour is a `Color`, a fog's wind a
`Vec3`. Every inspector therefore edits a colour, a vector or a material the same way.

## The types

| Type | Inspector | At runtime |
|---|---|---|
| `number`, `boolean`, `string` | A number (a slider with `min` and `max`), a toggle, a text box (a text area with `multiline`) | As is |
| `'melee' \| 'ranged'` | A list of those values | The string |
| `Vec2`, `Vec3`, `Vec4` (also gl-matrix `vec2` / `vec3` / `vec4`, and `[number, number, number]`) | X, Y, Z, W | The numbers, `[x, y, z]` |
| `Color` | A colour picker beside R, G, B | `[r, g, b]`, linear, 0 to 1 (more for a glow) |
| `ColorAlpha` | A colour picker beside R, G, B, A | `[r, g, b, a]` |
| `ClipName`, `SoundName`, `SocketName`, `TemplateName`, `NodeName`, `TriggerName`, `SpriteClipName`, `ParamName` | The names of that kind this node can reach | The name |
| `ActionName`, `SceneName`, `LayerName` | The project's input actions, scenes, collision layers | The name |
| `Material` | The material picker: thumbnails, "+ New material", and a drop from the Assets panel | The Material |
| `Texture` | A texture tile: pick, upload or drop | The Texture |
| `Sound` | The project's sound samples | The Sound (`play()`, `stop()`) |
| `Tileset` | The project's tilesets | The Tileset |
| `Node`, or any node class (`LightNode`, `SequenceNode`, `UIButtonNode`, …) | The scene's nodes of that class, or a drag from the scene tree | That node, or `null` |
| Another script's class (`door: SoulsDoor`, imported from that script) | The scene's nodes running that script | That node |
| `X[]`, a list of any type above | A list: one row per entry, Add and ✕ | An array |

**Asset fields** start empty (`= null`). The editor stores the asset's id, and the engine looks the asset up
when the script attaches, before `onConstruct`. A material or tileset is stored once in the game, however many
fields and nodes name it, so every field naming it holds the same object. Change that object and the change
shows wherever the material is used. An id the game does not have leaves the field `null` and logs one warning.

**Node fields** start empty too. The editor stores the path from the script's node to the one picked
(`../Gate/Lamp`). The path, unlike an id, keeps pointing at the right node in every copy of a template. The
engine fills the field before `onConstruct`, and again just before `onStart` for a node spawned in between.
A node still missing then leaves the field `null` with one warning, unless the field is declared `lamp?:`. A
value the script sets itself in `onConstruct` is kept.

A field that changes type keeps its value only when the new type can hold it: a `weapon: string` that becomes
`weapon: Material` starts over from its default.

## Saves and multiplayer

A `@save` field that holds an asset is saved as the asset's id, and loads back as the same asset. A node is
saved as that node, found again by id or by its path, as any node a script saves.

## Names, not assets

`TemplateName`, `ClipName` and the other name types hold a NAME, not an object. A template is instantiated by
name (`scene.instantiate(this.enemy)`), and a clip is played by name. The inspector lists the names the node can
reach. A trigger, an input action, a scene and a collision layer can only be one the project declares, so their
lists cannot be typed into.

## See also

- [Decorators](decorators.md): `@attribute` and its options (label, range, read-only, `showIf`, multiline).
- [Scripting workflow](../editor/scripting-workflow.md#attributes): the Behaviors panel.
