# UI

UI elements are ordinary scene nodes with their own layout pass, so a HUD lives in the scene tree
and is edited with the same tools as everything else.

Switch to **UI mode** to lay them out.

## Canvases

Everything lives under a **UI root**:

| Root | Entry | Behaviour |
|---|---|---|
| **Canvas** | Layout ▸ Canvas | Screen space. A HUD. Ignores the node transform entirely. |
| **World UI** | Layout ▸ World UI | World space. A panel over a machine or an enemy's head. Uses the node transform. |

A UI element dropped outside a root is automatically retargeted into the scene's first root,
creating one if there is none.

### Canvas scaling

A screen canvas scales from a **reference resolution** (default `1920 × 1080`):

| Scale mode | Behaviour |
|---|---|
| **Constant pixel** | One UI unit is one pixel. Fixed-size UI. |
| **Scale with screen** | Scales from the reference resolution, blending width and height by **Match**. |
| **Constant physical** | Scales to a reference DPI, so a button stays the same physical size. |

*Scale with screen* is what you want for a game HUD. Test it by resizing the window — it should
scale, not drift.

## Anchors and rectangles

Layout is an **anchor pair plus two offsets**, as in Unity's `RectTransform`. The **Anchor & Rect**
section holds anchor min/max, offset min/max and pivot.

| Anchors | Behaviour |
|---|---|
| Both `[0, 0]` | Pinned to one corner, fixed size. |
| min `[0,0]`, max `[1,1]` | Stretches with the parent. |
| Both `[0.5, 0.5]` | Centred, fixed size. |
| min `[0,0]`, max `[1,0]` | Full width, fixed height — a top or bottom bar. |

**Sizing: content** makes an element size itself to what it contains.

> Screen-space UI **ignores `Node.position`, `rotation` and `scale`**. Dragging a screen element in
> the viewport writes offsets, not a transform. Only a world-space root uses the node transform.

## Editing in the viewport

UI mode draws the real UI over the canvas and lets you manipulate it directly:

- **Click selects** instead of activating, so you can select a button without pressing it.
- **Drag to move**, with **eight resize grips**.
- Everything is expressed as offset deltas, with snap-to-guide.
- A selected element and its ancestors are **force-visible**, so you can edit something you have
  hidden.

## Element types

**Layout** — Canvas, World UI, Column, Row, Spacer.

**Elements** — Panel, Text, Image, Button.

**Widgets** — Progress, Slider, Toggle, Text Input.

Full properties: [Node types → UI](../reference/node-types.md#ui).

### Containers do the work

A **Column** or **Row** lays its children out with a gap, a justify and an align; a **Spacer** with
a flex weight pushes things apart. Between them you rarely need to position anything by hand — build
a HUD out of stacks and it survives resizing without further thought.

## Appearance

Every UI node has opacity, tint, z-order, clipping, padding, border radius, border width and border
colour.

> **Tints are sRGB `0..1` RGBA**, not linear. `[1, 0, 0, 1]` is red at full alpha.

Z-order sorts siblings; the tree provides the rest of the ordering.

## Widgets and scripts

Widget handlers are script hooks: `onPress()` on a button, `onValueChanged(value)` on a slider,
toggle and text input, `onSubmit(value)` on a text input.

```ts
import { UIButtonNode, Game } from 'cleo'

export default class PlayButtonNode extends UIButtonNode {
  public targetScene: string = 'Level 1'
  onPress() { Game.loadScene(this.targetScene) }
}
```

> A script assigning `value` **does not** fire `onValueChanged` — only user input does. That is what
> stops a script mirroring a value into a widget from re-entering itself.

Writing a whole HUD from one script is the usual approach — see [UI (scripting)](../scripting/ui.md).

## Touch controls

The **virtual controls** editor lets you drag on-screen sticks and buttons over a 16:9 preview,
using the same layout maths the runtime uses. Two ship by default: a movement stick and a jump
button.

They are previewed in Input mode, live in Play, and drawn only when the device reports a touch
screen — there is no separate "is touch enabled" switch to keep in sync.

Bind them like any other input source; see [Input](input.md).

## Visibility

UI is the **only** node family that persists `visible`, so hiding a panel in the editor stays hidden
at runtime. That makes "author the pause menu in place, hide it, spawn it on demand" work as you
would hope.

## Pause menus

UI layout still solves while paused and buttons still respond, so a pause menu needs no special
handling beyond switching input maps.

## See also

[UI (scripting)](../scripting/ui.md) · [Input](input.md) · [Node types → UI](../reference/node-types.md#ui)
