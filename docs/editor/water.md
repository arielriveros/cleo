# Water

One **Water** node can hold a whole body of water: a river that starts on a mountain, runs down the
valley and ends in a lake, or the ocean beyond the beach. The node is a list of shapes, edited like a
Collider's shapes: add a River, a Lake, a Box or an Ocean, shape it, and connect a river's start or end
to another shape so the two meet. Everything dynamic in the water floats by its mass against the water it
displaces, a river's current carries it downstream, and the waves it rides are the waves you see.

Add one from **Add › Simulation**: **Water Volume** (a box), **River**, **Lake** or **Ocean**. They are
all the same node, so a River can be given a Lake and the other way round.

## Water Volume

The Water node's inspector card: whether the water is on, its shapes, its waves, how it buoys what floats
in it, and the splashes it throws. The **Presets** menu sets the liquid (still pool, lake, river, sea,
rough sea, swamp, oil, lava): its density, drag, swell and the wind its waves are shaped for, never the
shapes or what the node links to.

| Field | What it does |
|---|---|
| **Enabled** | Off: the water buoys nothing and draws nothing. |

## Shapes

The shapes the water is made of, one row each. The icon buttons above the list add a river, a lake, a
box or an ocean. A shape is selected by clicking its row (or its outline in the viewport); its row stays
open while it is selected. Shapes are in the node's units: moving or scaling the node moves or scales
them all, and the node's rotation is ignored (water stays level).

**Shape** — one shape on the list, titled by its name or its type and place ("River 1"): its fields, a
frame button that points the camera at it, and a menu to duplicate, reorder or remove it. Removing a
shape also disconnects whatever flowed into it.

| Field | What it does |
|---|---|
| **Priority** | Where two shapes overlap, the higher priority is the water there: a river (priority 1 by default) cuts through the lake (0) it runs into. On a tie, the later shape on the list wins. |
| **Centre** | A box's centre. Its top face is the surface. |
| **Size** | A box's width, depth and length in metres, before the node's scale. |
| **Level** | A lake's or ocean's centre; its height is the surface. |
| **Depth** | A lake's or ocean's depth below the surface, metres. Where the landscape is higher, it is the floor. |
| **Extent** | Metres the ocean reaches each way from its centre. 0: endless, to the horizon. |
| **Offset** | Moves a whole river. |
| **Flows from** | The shape a river starts in. Its first point takes that shape's surface, so the two meet. |
| **Flows into** | The shape a river ends in. Its last point takes that shape's surface, so the river runs into it. A new river flows into the node's first lake or ocean. |
| **Position** | Where a point is: on a river, its centre line at the surface; on a lake, a point of the outline (the height is the lake's level). |
| **Width** | Metres from bank to bank at a river point. |
| **Flow speed** | Metres per second downstream at a river point: how fast the river carries what floats. |
| **Carve landscape** | A river's or lake's bed is dug into the landscape when **Carve landscape** under the list is pressed: the bed inside the water and a sloped bank outside it. It only ever lowers the ground, and the carve is one undo step. |
| **Bank width** | Metres the carved bank slopes over, from the water's edge back up to the ground. |
| **Dig deeper** | Metres the carve digs below the water's own depth. |

### Rivers

A river is a smooth spline through its points, listed upstream to downstream. Each point has its own
**Width**, **Depth** and **Flow speed**, which ease from one point to the next; the channel is deepest and
fastest on its centre line and shallow and slow at the banks. The surface follows the points' heights, so
a river runs downhill as its points do. Add a point at the end with the plus button.

### Lakes

A lake is a level surface inside the smooth closed outline through its points, **Depth** deep.

### Oceans

An ocean is a level surface with no shore unless you give it an **Extent**. It carries the node's waves in
full: open water lets the wind build the longest and tallest of them.

### Connecting shapes

Set a river's **Flows into** to a lake, the ocean or another river and its last point takes that shape's
surface: the river drops into the lake at its level, or joins the other river where it meets it. **Flows
from** does the same for the river's start, for a river that drains a lake. Rivers that join rivers are
worked out in the order they flow, wherever they are on the list.

## Surface

How the water looks, from a **Water material**: pick one from the library (or make one with **+ New
material**), and edit it right here; a linked material's edits reach every Water node drawing with it.
With none, the water takes the default clear-lake look. The menu beside the picker applies a look
(clear lake, tropical lagoon, alpine river, murky swamp, open ocean, swimming pool).

The surface is single-layer water: what is under it is seen through it, bent by the waves and dimmed and
tinted by the water it crosses, with caustics on the bed; it reflects the scene (screen-space) over the sky;
and foam gathers on the shore, on breaking crests and in rapids. Rain from a Weather volume rings it, snow
settles on still water as slush and then ice, and the scene's wind roughens it. Seen from below, it
reflects the water back outside Snell's window.

| Field | What it does |
|---|---|
| **Shallow colour** | The tint of light scattered near the surface: what shallow water looks like. |
| **Deep colour** | The colour deep water takes: light scattered back from far down. |
| **Absorption** | How fast each colour dies with depth (brighter is absorbed faster). Clear water loses red first, so its depths turn blue-green. |
| **Murkiness** | Suspended silt: murky water hides the bed a short way down. |
| **Clarity** | Metres you can see down before the scattering hides the bed. |
| **Reflectivity** | Reflectance looking straight down (water is 0.02); grazing reflection rises toward a mirror by Fresnel. |
| **Roughness** | How blurred the reflections are: 0 a mirror. Wind adds to it. |
| **Screen reflections** | How much the screen-space reflection of the scene is used over the sky. Needs Screen-Space Reflections on in the Renderer settings. |
| **Refraction** | How far what is under the surface bends with the waves. |
| **Ripples** | Strength of the small ripples on top of the waves. |
| **Ripple size** | Metres across the small ripples. |
| **Flow** | How far the ripples and foam ride the current, so a river visibly runs. |
| **Foam colour** | The colour of the foam. |
| **Shore foam** | Metres of foam along the shore and in thin water, with surf lines running in. |
| **Crest foam** | Foam on breaking wave crests. |
| **Rapids foam** | Foam where the water runs fast or drops: rapids, weirs, waterfalls. |
| **Caustics** | Brightness of the light the waves focus on the bed. |
| **Caustics size** | Metres between the caustic lines. |
| **Rain rings** | How much rain from a Weather volume rings the surface. |
| **Snow and ice** | How much snow from a Weather volume settles on still water, as slush and then ice. |
| **Wind** | How much the scene's wind roughens the surface. |
| **Underwater colour** | The colour of the water seen from inside it. |
| **Underwater fog** | How thick the water is to see through from inside it, per metre. |

### Level of detail

The surface is drawn in tiles: each is as dense as its distance from the camera calls for, from 64
quads across close up to 8 far away, and the waves, ripples and reflections fade out with distance. An
endless ocean adds rings of ever larger tiles round the camera to the horizon. Tiles out of view, or past
the node's **Draw distance**, are not drawn.

## Flow bake

A simulation of the water itself: **Bake flow** runs shallow water over the shapes and the landscape
under them until it settles, and the surface then draws what it found: currents that bend round the
banks and swirl behind a bend, water piling up and speeding over a drop, foam where it tumbles. It takes
a few seconds, the editor keeps drawing meanwhile, and **Cancel** stops it. Without a bake the surface
draws the analytic flow along each river. Floating bodies ride the baked water too: its surface and its
currents carry them. The bake is saved with the project and published with the game.

While a river's first metres feed it, lakes, boxes and the ocean keep their levels and take what the
rivers bring, and outside the shapes is dry: the shapes say where water may be, the landscape how deep
it is. Moving or editing a shape makes the bake stale, and the analytic flow draws again until the next
bake; carving or sculpting the landscape does not, so bake again after it.

| Field | What it does |
|---|---|
| **Bake resolution** | Cells along the longest side of the water: finer catches narrower channels and takes longer. |

## Waves

Gerstner waves shaped by the wind: the longer and stronger the wind blows over open water, the longer,
taller and faster they are. A lake limits them to what its size lets build; an endless ocean lets them
grow fully developed; rivers carry only a small share of them. Floating bodies ride the same waves the
surface draws.

| Field | What it does |
|---|---|
| **Wind speed** | Metres per second the waves are shaped for. 0: no waves, only the swell. |
| **Direction** | Degrees the waves travel toward: 0 is +Z, 90 is +X. |
| **Height** | Multiplies the wave height the wind gives. |
| **Choppiness** | Rounded swells (0) to sharp crests (1). |
| **Follow wind** | The scene's Wind node raises and calms the waves: their height follows its speed against **Wind speed**, squared as a sea's does, up to twice as tall. Their length and direction stay as shaped. |
| **Shore fade** | Metres from a shore over which the waves die down. |
| **Swell** | Metres the whole surface rises and falls, so floating bodies bob even with no wind. 0: none. |
| **Swell rate** | How many times a second the swell rises and falls. |

## Buoyancy

How the water floats and slows what is in it. Physics runs in Play. Every dynamic body floats by its mass
against the water its colliders displace: denser than the water sinks, lighter floats higher, and a tipped
body rights itself.

| Field | What it does |
|---|---|
| **Density** | kg/m³ (fresh water 1000, sea water 1025). |
| **Drag** | Per second, at full submersion: how quickly a body in the water takes on the water's own speed. In still water that slows it; in a river it carries it along. |
| **Spin drag** | Per second, at full submersion: how quickly a body stops tumbling. |
| **Currents** | Flowing water carries what floats downstream. Off: rivers are as still as lakes to the physics. |
| **Buoy characters** | Off by default: a character capsule is mostly air and would be launched out of the water. |

## Splashes

What moves through the water disturbs it.

| Field | What it does |
|---|---|
| **Splash** | Template spawned at the surface where something enters the water or wades through it. |
| **Wading splash** | Template for the footsteps of a character wading. Same as Splash when not set. |
| **Surface model** | Legacy: a model drawing the water whose custom material declares `vec4` uniforms `ripple0` … `ripple11`, filled with rings from whatever moves through. While one is set the node draws no surface of its own, so an older scene keeps its look; clear it to switch to the Water material. |

## Scripting

`WaterVolumeNode` exposes the water to scripts: `shapes` (replace the list to edit it), `addShape(type)`,
`columnAt(x, z, time?)` (surface, floor and flow over a point, or null), `surfaceHeightAt(x, z, t)`,
`contains(p)`, `depthAt(p)` and `waves()`. See [Node types](../reference/node-types.md#watervolumenode--watervolume-unreleased).
