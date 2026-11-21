# UI

UI elements are ordinary scene nodes with their own layout pass, so a HUD lives in the scene tree
and is edited with the same tools as everything else.

Switch to **UI mode** to lay them out.

## Canvases

Everything lives under a **UI root**. A root's first inspector section, **Canvas**, sets its space —
screen or world — and then a screen canvas's reference size and scaling, or a world one's follow
node, reference distance, scale limits, and whether it clamps to the screen or hides behind the
camera:

| Root | Entry | Behaviour |
|---|---|---|
| **Canvas** | Layout ▸ Canvas | Screen space. A HUD. Ignores the node transform entirely. |
| **World UI** | Layout ▸ World UI | World space. A panel over a machine or an enemy's head. Uses the node transform. |

| Field | Meaning |
|---|---|
| **Space** | **Screen**, drawn over the view, or **World**, a panel placed in the scene. |
| **Reference size** | The resolution the layout is authored at, width and height (default `1920 × 1080`). |
| **Scale mode** | How a screen canvas scales: see [Canvas scaling](#canvas-scaling). |
| **Match** | With **Scale with screen**: `0` scales by the width, `1` by the height, between blends the two. |
| **Follow** | A world canvas: the node it floats over. Empty: this node. |
| **Reference distance** | A world canvas: the camera distance at which it shows at its reference size. |
| **Min scale** / **Max scale** | A world canvas: the limits of its scale with distance. |
| **Clamp to screen** | A world canvas: keep it inside the screen's edges when what it follows is off screen. |
| **Hide behind camera** | A world canvas: hide it while what it follows is behind the camera. |

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
section (on everything but a root) picks the anchors from a grid of presets — nine pins, the
horizontal and vertical stretches, and stretch both — then holds the offsets, the pivot, a rotation
and a scale. On a pinned axis the offsets read as position and size; on a stretched one, as insets
from each edge. The stored data is the same either way.

| Anchors | Behaviour |
|---|---|
| Both `[0, 0]` | Pinned to one corner, fixed size. |
| min `[0,0]`, max `[1,1]` | Stretches with the parent. |
| Both `[0.5, 0.5]` | Centred, fixed size. |
| min `[0,0]`, max `[1,0]` | Full width, fixed height — a top or bottom bar. |

| Field | Meaning |
|---|---|
| **Pos X** / **Pos Y** | On a pinned axis: the position, from the anchor. |
| **Width** / **Height** | On a pinned axis: the size. |
| **Left** / **Right** | On a stretched horizontal axis: the insets from each edge. |
| **Top** / **Bottom** | On a stretched vertical axis: the insets from each edge. |
| **Pivot** | The point it rotates and scales about, `0` to `1` across its width and height. |
| **Rotation** | Degrees, about the pivot. |
| **Scale** | Width and height multipliers, about the pivot. |

**Sizing: content** makes an element size itself to what it contains.

> Screen-space UI **ignores `Node.position`, `rotation` and `scale`**. Dragging a screen element in
> the viewport writes offsets, not a transform. Only a world-space root uses the node transform.

## Editing in the viewport

UI mode draws the real UI over the canvas and lets you manipulate it directly. Other authoring modes
hide it by default, so a HUD does not cover the scene; **Game UI** in the viewport's eye menu shows it
there too. Play always draws it.

In UI mode:

- **Click selects** instead of activating, so you can select a button without pressing it.
- **Drag to move**, with **eight resize grips**.
- Everything is expressed as offset deltas, with snap-to-guide.
- A selected element and its ancestors are **force-visible**, so you can edit something you have
  hidden.

## Element types

Each type has its own fields, shown first in its inspector under **Element**: a text's string and
font, an image's texture, a button's label, a widget's range and value. The types:

**Layout** — Canvas, World UI, Column, Row, Spacer.

**Elements** — Panel, Text, Image, Button.

**Widgets** — Progress, Slider, Toggle, Text Input.

Full properties: [Node types → UI](../reference/node-types.md#ui).

### Text

A line or a block of text.

| Field | Meaning |
|---|---|
| **Text** | What it says. |
| **Font size** | In UI units. |
| **Font family** | A CSS font family. Empty: the canvas's. |
| **Weight** | The font weight, 100 (thin) to 900 (black); 400 is regular. |
| **Align** | **Left**, **Center** or **Right**. |
| **Vertical** | **Top**, **Middle** or **Bottom** of its rect. |
| **Wrap** | Break lines at its rect's width. |
| **Line height** | Times the font size. |
| **Letter spacing** | Extra space between letters, in ems. |

### Image

A texture drawn in its rectangle.

| Field | Meaning |
|---|---|
| **Texture** | The image it shows, from the Assets panel. |
| **Fit** | How the image fills its rect: **Fill** stretches, **Contain** fits inside, **Cover** fills and crops, **Tile** repeats. |

### Button

A pressable label. Pressing it calls `onPress()` on its script.

| Field | Meaning |
|---|---|
| **Label** | Its text. |
| **Disabled** | Shown dimmed, and not pressed. |
| **Disabled color** | Its tint while disabled. |

### Column and Row

A stack: it lays its children out one after another, down or across.

| Field | Meaning |
|---|---|
| **Direction** | **Column** stacks its children down, **Row** across. |
| **Gap** | The space between children. |
| **Justify** | Where the children sit along the stack: **Start**, **Center**, **End**, **Space between** or **Space around**. |
| **Align** | Where each child sits across the stack: **Stretch** to fill, **Start**, **Center** or **End**. |
| **Reverse** | Lay the children out last first. |

### Spacer

Empty space in a stack, taking a share of what is left over.

| Field | Meaning |
|---|---|
| **Flex** | Its share of the stack's free space. |

### Progress

A bar filled from its minimum to its maximum.

| Field | Meaning |
|---|---|
| **Min** / **Max** | The range of its value. |
| **Value** | How full it is, in that range. |
| **Fill color** | The fill's tint. |
| **Direction** | Which way it fills: **Left to right**, **Right to left**, **Bottom to top** or **Top to bottom**. |
| **Smoothing** | Seconds the shown fill takes to catch up with the value. `0` snaps. |

### Slider

A handle dragged along a track. Moving it calls `onValueChanged(value)` on its script.

| Field | Meaning |
|---|---|
| **Min** / **Max** | The range of its value. |
| **Step** | The increment it moves in. `0`: any value. |
| **Value** | Where the handle is, in that range. |
| **Vertical** | Slide up and down, not across. |
| **Fill color** | The filled part's tint. |
| **Handle color** | The handle's tint. |

### Toggle

A switch with a label.

| Field | Meaning |
|---|---|
| **Label** | Its text. |
| **Checked** | Whether it is on. |
| **On color** / **Off color** | Its tint when on and when off. |

### Text Input

A field the player types into.

| Field | Meaning |
|---|---|
| **Value** | The text in it. |
| **Placeholder** | Shown while it is empty. |
| **Max length** | The most characters it takes. `0`: no limit. |
| **Font size** | In UI units. |
| **Password** | Show dots for what is typed. |
| **Read only** | Shown, not edited. |

### Containers do the work

A **Column** or **Row** lays its children out with a gap, a justify and an align; a **Spacer** with
a flex weight pushes things apart. Between them you rarely need to position anything by hand — build
a HUD out of stacks and it survives resizing without further thought.

## Appearance

Every UI node has a colour (its tint, with alpha), opacity, z-order, whether it is interactive,
clipping of its children, corner radius, a border width and colour, and padding.

| Field | Meaning |
|---|---|
| **Color** | Its tint, with alpha, multiplying what it draws. |
| **Opacity** | How much of it, and of its children, shows. |
| **Z order** | Sorts it among its siblings: higher draws on top. |
| **Interactive** | Takes the pointer: presses, hovers and drags. Off, the pointer goes through it. |
| **Clip children** | Cut its children off at its rect. |
| **Corner radius** | Rounds its corners, in UI units. |
| **Border width** | Its outline's thickness. `0`: none. |
| **Border color** | Its outline's colour, with alpha. |
| **Padding** | The space kept inside its edges for its children: left, top, right and bottom. |

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

They are previewed in Options ▸ Project ▸ Input, live in Play, and drawn only when the device reports a touch
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
