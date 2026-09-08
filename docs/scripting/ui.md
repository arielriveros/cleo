# UI

UI elements are ordinary scene nodes with their own layout pass. That means a HUD is part of the
scene tree, can be spawned and despawned, can carry scripts, and is edited with the same tools as
everything else.

The eleven node types and their properties are in
[Node types → UI](../reference/node-types.md#ui); authoring is in [UI (editor)](../editor/ui.md).

## Screen space and world space

A `UIRootNode` is either:

- **screen** — a HUD. Ignores `Node.position` / `rotation` / `scale` entirely; everything is
  anchors and offsets, scaled from a reference resolution (default `1920 × 1080`).
- **world** — a panel that lives in the scene, above a machine or over an enemy's head. Uses the
  node transform, and can billboard, clamp to screen edges and hide behind the camera.

## Layout

Rectangles are authored the way Unity's `RectTransform` works: an **anchor** pair against the
parent, plus two **offsets**.

```ts
anchorMin: [number, number]     // 0..1 of the parent rect
anchorMax: [number, number]
offsetMin: [number, number]     // pixels from the anchor
offsetMax: [number, number]
pivot: [number, number]
```

| Anchors | Behaviour |
|---|---|
| both `[0, 0]` | Pinned to one corner; fixed size. |
| min `[0,0]`, max `[1,1]` | Stretches with the parent. |
| both `[0.5, 0.5]` | Centred; fixed size. |
| min `[0,0]`, max `[1,0]` | Full width, fixed height — a top or bottom bar. |

Helpers:

```ts
setRect(x: number, y: number, w: number, h: number): void
setAnchor(x: number, y: number): void
stretch(l: number, t: number, r: number, b: number): void
```

Resolved values are read-only and **live objects rewritten in place**: `rect`, `localRect`,
`screenRect`, `clipRect`, `resolvedOpacity`, `resolvedVisible`, `onScreen`, `measuredContentSize`.

`sizing: 'content'` makes an element size itself to what it contains rather than to its rect.

## Containers

`UIStackNode` lays children out in a row or column with a `gap`, a `justify` and an `align`.
`UISpacerNode` has a `flex` weight and pushes things apart. Between them you rarely need to
position anything by hand.

## Colours

`tint` and the other colour fields are **sRGB `0..1` RGBA**, not linear. `[1, 0, 0, 1]` is red at
full alpha.

## Writing a HUD

One script for the whole HUD, rather than one per element: find the widgets once, write them every
frame.

```ts
import { Node, UIProgressBarNode, UIRootNode, UITextNode } from 'cleo'

export default class HudNode extends UIRootNode {
  private _player: Node | null = null
  private _clock: UITextNode | null = null
  private _health: UIProgressBarNode | null = null

  onStart() {
    this._player = this.findNode('Playable')
    this._clock  = this._find('Clock')  as UITextNode
    this._health = this._find('Health') as UIProgressBarNode

    const player = this._player as any
    if (this._health && player) {
      this._health.min = 0
      this._health.max = player.maxHealth ?? 100
    }
  }

  onUpdate() {
    const player = this._player as any
    if (this._clock)  this._clock.text = this.clockText()
    if (this._health && player) this._health.value = player.health
  }

  /** Depth-first over this root's own subtree — getChildByName is direct children only. */
  private _find(name: string): Node | null {
    const walk = (node: Node): Node | null => {
      for (const child of node.children) {
        if (child.name === name) return child
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this)
  }
}
```

Two things make this cheap enough to do every frame:

- **Assigning an unchanged value early-returns.** Writing the same string to `text` or the same
  number to `value` does nothing.
- **The UI layout pass runs after every `onUpdate`**, so a value written here is on screen the same
  frame, not one behind.

Skipping missing widgets rather than asserting lets you build a HUD up a piece at a time.

## Widget handlers

```ts
onPress(): void                          // UIButtonNode
onValueChanged(value: number): void      // UISliderNode
onValueChanged(checked: boolean): void   // UIToggleNode
onValueChanged(value: string): void      // UITextInputNode
onSubmit(value: string): void            // UITextInputNode
```

```ts
import { UIButtonNode, Game } from 'cleo'

export default class PlayButtonNode extends UIButtonNode {
  public targetScene: string = 'Level 1'

  onPress() { Game.loadScene(this.targetScene) }
}
```

> **Assigning `value` does not fire `onValueChanged`** — only user input does. That is what stops a
> script mirroring a value into a widget from re-entering itself. To apply a value as if the user
> had, use `setValueFromFraction`, `toggle()`, `setValueFromInput()` or `press()`.

## Showing and hiding

UI is the only node family that **persists `visible`**, so hiding a panel in the editor stays hidden
at runtime.

```ts
private _pip(bar: UIProgressBarNode | null, left: number, duration: number): void {
  if (!bar) return
  const running = left > 0
  if (bar.visible !== running) bar.visible = running     // only write on a change
  if (running) bar.value = left / Math.max(0.001, duration)
}
```

## Progress bars

`min`, `max`, `value`, `direction` (`'ltr' | 'rtl' | 'btt' | 'ttb'`), and `smoothing`, which eases
the fill toward its target. Smoothing advances in `update`, so it **freezes while paused** — which
is what you want for a pause menu, and worth knowing if you expected a bar to keep animating.

## World-space UI

```ts
space: 'world'
uiTargetId: string            // node to follow
referenceDistance: number     // distance at which scale is 1
minScale / maxScale: number
billboard: boolean
clampToScreen: boolean        // keep an off-screen marker at the edge
hideBehindCamera: boolean
```

Readouts: `scaleFactor`, `origin`, `offscreen`, `edgeAngleDeg`. `edgeAngleDeg` is what you point an
off-screen arrow with.

## Menus and pausing

UI layout still solves while paused, and buttons still respond, so a pause menu works with no
special handling. Switch input context at the same time:

```ts
Game.pause()
Input.enableMap('UI')
Input.disableMap('Gameplay')
```

## Layout helpers

If you compute your own rectangles: `uiSetRect`, `uiSolveRect`, `uiRootScale`, `uiProjectToScreen`,
`worldUIScale`, `uiIntersectRect`, `uiRectOffscreen`, `uiStackLayout`.

## See also

[UI (editor)](../editor/ui.md) · [Node types → UI](../reference/node-types.md#ui) · [Scene and game](scene-and-game.md)
