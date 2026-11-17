# Water

A **Water** node is one body of water: a **River**, a **Lake**, an **Ocean** or a **Pool**. Everything
dynamic in it floats by its mass against the water it displaces, a river's current carries it downstream,
and the waves it rides are the waves you see. A river joins other Water nodes by naming them: a river that
starts on a mountain and ends in a lake is a River node flowing into a Lake node, and the river meets the
lake's surface where it runs in.

Add one from **Add › Simulation › Water Volume**: it starts as a lake, and the inspector's **Water body** card
turns it into any other type.

## Water Volume

The Water node's inspector card: whether the water is on, its body, its surface, its waves, how it buoys
what floats in it, and the splashes it throws. The badge on the card names the body's type. The
**Presets** menu sets the liquid (still pool, lake, river, sea, rough sea, swamp, oil, lava): its density,
drag, swell and the wind its waves are shaped for, never the body or what the node links to.

| Field | What it does |
|---|---|
| **Enabled** | Off: the water buoys nothing and draws nothing. |

## Water body

What the water is, from the strip of icons at the top of the **Water body** card, and that type's fields. The
body is in the node's units: the node's position is its origin (a pool's centre, a lake's or ocean's
surface), its scale scales it, and its rotation is ignored (water stays level). Changing the type keeps the
liquid and the look and starts the new type's own shape from its default. With the node selected, the
viewport shows the body's handles: a point per river or lake point (drag it; Shift drags a river point up
and down), a **+** between neighbours to insert a point, a handle on each river bank for its width, and a
handle on each face of a pool to resize it about its centre. Delete removes the selected point.

| Field | What it does |
|---|---|
| **River** | A smooth spline through its points, listed upstream to downstream. Each point has its own **Width**, **Depth** and **Flow speed**, easing from one point to the next; the channel is deepest and fastest on its centre line and shallow and slow at the banks. The surface follows the points' heights, so the river runs downhill as its points do. |
| **Lake** | A level surface at the node's height inside the smooth closed outline through its points, **Depth** deep. |
| **Ocean** | A level surface at the node's height with no shore unless you give it an **Extent**. Open water lets the wind build the longest and tallest waves. |
| **Pool** | A level block of water centred on the node, **Size** big: a tank, a fountain, a flooded room. Its top face is the surface. |
| **Size** | A pool's width, depth and length in metres, before the node's scale. |
| **Depth** | A lake's or ocean's depth below the surface, metres. Where the landscape is higher, it is the floor. |
| **Extent** | Metres the ocean reaches each way from the node. 0: endless, to the horizon. |
| **Flows from** | The Water node a river starts in: a lake it drains, a river it branches from. Its first point takes that water's surface, so the two meet. |
| **Flows into** | The Water node a river ends in: a lake, the ocean, another river. Its last point takes that water's surface and the river runs on into it. |
| **Position** | Where a point is: on a river, its centre line at the surface; on a lake, a point of the outline (the lake's level is the node's height). |
| **Width** | Metres from bank to bank at a river point. |
| **Flow speed** | Metres per second downstream at a river point: how fast the river carries what floats. |
| **Carve landscape** | A river's or lake's bed is dug into the landscape when the **Carve landscape** button is pressed: the bed inside the water and a sloped bank outside it. It only ever lowers the ground, and the carve is one undo step. |
| **Bank width** | Metres the carved bank slopes over, from the water's edge back up to the ground. |
| **Dig deeper** | Metres the carve digs below the water's own depth. |

### Connecting water

Set a river's **Flows into** to a lake, the ocean, a pool or another river and its last point takes that
water's surface: the river drops into the lake at its level, or joins the other river where it meets it.
**Flows from** does the same for the river's start, for a river that drains a lake. In the viewport,
dropping a river's first or last point on another Water node's water connects it, and dragging it back out
lets go.

Where the river runs into what it joins, the other water is the water: it draws the surface there and buoys
what floats, so a log drifting out of the river mouth is carried into the lake without being lifted twice,
and the river's edge there grows no shore foam. Move the lake and the river's mouth follows it.

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
| **Scatter colour** | The colour light takes travelling through the water before it reaches you: subsurface scattering, what thin wave crests and the faces of waves glow with when the sun is behind them. Clear water scatters green-turquoise, silty water brown-green. |
| **Subsurface** | How strongly light shines through the waves. 0: none; murky water barely scatters forward whatever this says. |
| **Scatter focus** | How tightly the glow gathers round looking toward the sun: low spreads it wide, high keeps it to the backlit crests. |
| **Scatter spread** | How far the waves' slopes bend the light through them, spreading the glow over their faces rather than only where the sun is exactly behind them. |
| **Underwater colour** | The colour of the water seen from inside it. |
| **Underwater fog** | How thick the water is to see through from inside it, per metre. |

### Level of detail

The surface is drawn in tiles: each is as dense as its distance from the camera calls for, from 64
quads across close up to 8 far away, and the waves, ripples and reflections fade out with distance. An
endless ocean is drawn in rings of ever larger tiles round the camera to the horizon. Tiles out of view, or
past the node's **Draw distance**, are not drawn.

## Flow bake

A simulation of the water itself: **Bake flow** runs shallow water over the body and the landscape
under it until it settles, and the surface then draws what it found: currents that bend round the
banks and swirl behind a bend, water piling up and speeding over a drop, foam where it tumbles. It takes
a few seconds, the editor keeps drawing meanwhile, and **Cancel** stops it. Without a bake the surface
draws the analytic flow along each river. Floating bodies ride the baked water too: its surface and its
currents carry them. The bake is saved with the project and published with the game.

A river's first metres feed it, and the water it flows into keeps its level and takes what the river
brings. Moving or editing the body, or the water it joins, makes the bake stale, and the analytic flow
draws again until the next bake; carving or sculpting the landscape does not, so bake again after it.

| Field | What it does |
|---|---|
| **Bake resolution** | Cells along the longest side of the water: finer catches narrower channels and takes longer. |

## Waves

Gerstner waves shaped by the wind: the longer and stronger the wind blows over open water, the longer,
taller and faster they are. A lake or pool limits them to what its size lets build; an endless ocean lets
them grow fully developed; a river carries only a small share of them. Floating bodies ride the same waves the
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

`WaterVolumeNode` exposes the water to scripts: `waterType`, `points`, `size`, `depth`, `extent`,
`flowsFrom` and `flowsInto` (the body; set them to edit it), `columnAt(x, z, time?)` (surface, floor and
flow over a point, or null), `surfaceHeightAt(x, z, t)`, `contains(p)`, `depthAt(p)` and `waves()`. See [Node types](../reference/node-types.md#watervolumenode--watervolume-unreleased).
