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
| **Deep colour** | The colour deep water takes: the share of the light going down that the water scatters back up. A real sea's is a few percent, in the blue, so open water is dark and takes most of its colour from the sky it reflects. |
| **Absorption** | How fast each colour dies with depth (brighter is absorbed faster). Clear water loses red first, so its depths turn blue-green. The bed darkens with depth twice over: the light going down to it and coming back up. |
| **Murkiness** | Suspended silt: murky water hides the bed a short way down. |
| **Clarity** | Metres you can see down before the scattering hides the bed. |
| **Reflectivity** | Reflectance looking straight down (water is 0.02); grazing reflection rises toward a mirror by Fresnel. |
| **Roughness** | How blurred the reflections are: 0 a mirror. Wind adds to it. |
| **Screen reflections** | How much the screen-space reflection of the scene is used over the sky. Needs Screen-Space Reflections on in the Renderer settings. |
| **Refraction** | How far what is under the surface bends with the waves. |
| **Ripples** | Strength of the waves under a metre long: the ripples the wind raises on the waves. 1 is the wind's own; floating bodies do not feel them. |
| **Foam size** | Metres across the bubble web the foam is drawn with. |
| **Flow** | How far the waves and foam ride the current, so a river visibly runs. |
| **Foam colour** | The colour of the foam. |
| **Shore foam** | Metres of foam along the shore and in thin water, with surf lines running in; on an ocean, the foam of its breaking surf. |
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
quads across close up to 8 far away. A wave moves the surface only where the tiles are dense enough to
draw it; past that, down to the smallest ripples, the shading draws it, and what a pixel is too
coarse to show becomes roughness: a distant sea's glints merge into the broad glitter path under the sun,
as a real one's do. An endless ocean is drawn in tiles that grow with distance and blend into each other,
to the horizon. Tiles out of view, or past the node's **Draw distance**, are not drawn. On a landscape the
ocean knows where the beach is: its waves die down over **Shore fade** and never stand taller than the
water is deep.

## Flow bake

A simulation of the water itself: **Bake flow** runs the shallow-water equations over the water, the
landscape under it and the static colliders standing in it until the water settles, and the surface then
draws what it found: currents that bend round the banks and round a rock, wakes and eddies behind it, water
speeding over a shallow bar and piling up before a narrows, foam where it tumbles. Floating bodies ride the
baked water too: its surface and its currents carry them. The bake runs in the background while the editor
keeps drawing; **Cancel** stops it. Without a bake the surface draws the analytic flow along each river. The
bake is saved with the project and published with the game.

What it simulates:

- **The ground decides the banks.** The water may run a little past the outline you drew (a bank's width,
  or 4 m) where the ground is lower, never further: a river laid a little off its valley's floor still
  follows the valley.
- **Static colliders are obstacles.** A Collider with no mass standing out of the water is a wall the water
  goes round; one under the surface raises the bed, and the water speeds over it. Colliders with mass (what
  floats or falls) are not part of the bake.
- **A river brings its own water.** Its first metres are fed the water its first point carries (width ×
  depth × flow speed); after that the slope and the bed's roughness decide how fast and deep it runs, as a
  real river's do. Where it runs into a lake or the sea it hands the water over; a river that runs into
  nothing drains at its end.
- **A lake takes what its rivers bring** and loses it to the rivers that drain it, holding its level.

One press bakes the whole group: everything joined to this water through **Flows from** and **Flows into**,
upstream first, so a lake is baked after the rivers that feed it. Moving or editing the water, the water it
joins, the landscape under it or a static collider in it makes the bake stale, and the analytic flow draws
again until the next bake.

| Field | What it does |
|---|---|
| **Bake resolution** | Cells along the longest side of the water: finer catches narrower channels and smaller rocks, and takes longer. |
| **Bed roughness** | Manning's roughness of the bed: 0.01 smooth concrete, 0.03 a natural channel, 0.1 a weedy, bouldery one. The rougher, the slower and deeper the water runs. |

## Waves

Waves raised by the wind, as many as forty of them from the longest the wind builds down to ripples a
centimetre and a half long, each one shorter than the last and running at its own natural speed. Each has a
sharp crest over a broad trough, as wind waves do; they run in scattered directions, their crests bent and
broken into short segments; and the long waves gather the short ones onto their crests, so the sea reads as
water rather than as a pattern. The waves are afl_ext's (from the Shadertoy "Very fast procedural ocean", MIT
licence); the crest bending follows TDM's "Seascape".

The sea is the one that wind raises: its height is the significant wave height measured for that wind over that
much open water (the **Fetch**), and its roughness, how much the surface tilts, is what Cox and Munk measured
from the sun's glitter on real seas. A short fetch raises a young sea of short, steep, choppy waves; a long one
the long swell of the open ocean. A lake or pool limits them to what its size lets build, an endless ocean
lets them grow fully developed unless **Fetch** says otherwise, and a river carries only a small share of them.
Floating bodies ride the same waves the surface draws, all those a metre long or more.

### Surf

On a landscape, an ocean's waves break on its beaches. Over the last few metres of depth the open sea's waves
give way to surf: breakers at the sea's own period that slow as the water shallows, so their crests bunch up
and turn to follow the shore; that grow as they come in and break where they stand about as tall as the water
is deep; and that run up the beach and drain back, foaming as they break and as each one spends itself on the
sand. Calm seas lap; a strong wind's sea pounds. The surf comes in sets, bigger and smaller, differing along
the shore. Floating bodies in it rise with each breaker, are carried in on it and drawn back by the backwash.
Nothing to set: the waves decide it.

| Field | What it does |
|---|---|
| **Wind speed** | Metres per second the waves are shaped for. 0: no waves, only the swell. |
| **Fetch** | Metres of open water the wind has crossed: a short fetch raises a young sea of short, steep, choppy waves; a long one the long swell of the open sea. 0: what the body gives (an endless ocean is the open sea). |
| **Direction** | Degrees the waves travel toward: 0 is +Z, 90 is +X. The longest run with the wind; the short ones, raised by every gust, run every way. |
| **Height** | Multiplies the wave height the wind gives. |
| **Choppiness** | How hard the long waves crowd the short ones onto their crests: 0 an even chop, 1 the small waves bunched on every crest. |
| **Wave speed** | How fast the waves and ripples run against their natural pace. 1 is real: a wave runs as fast as its length makes it (a 40 m ocean swell at 8 m/s, a lake's 1 m chop at 1.2 m/s). Below 1, a calmer, slower sea. Floating bodies ride the waves at the same pace. |
| **Follow wind** | The scene's Wind node raises and calms the waves: their height follows its speed against **Wind speed**, squared as a sea's does, up to twice as tall. Their length and direction stay as shaped. A sea set to a stronger wind than the Wind node blows (offshore winds often are) is flattened by it: leave this off there. |
| **Shore fade** | Metres from a shore over which the waves die down. |
| **Swell** | Metres the whole surface rises and falls, so floating bodies bob even with no wind. 0: none. |
| **Swell rate** | How many times a second the swell rises and falls. |

## Buoyancy

How the water floats and moves what is in it. Physics runs in Play. Every dynamic body floats by its mass
against the water its colliders displace: denser than the water sinks, lighter floats higher, and a tipped
body rights itself. The water pushes along its own slope, so a body slides down the face of a wave and drifts
down a river's gradient; and drag pulls it toward the water's own motion, the current and the waves'
orbits, so what floats rides the waves you see (they run on the same clock in Play) instead of bobbing
against them. Where a river runs into the water it flows into, a body there is in one of them, never both.

| Field | What it does |
|---|---|
| **Density** | kg/m³ (fresh water 1000, sea water 1025). |
| **Drag** | Per second: how quickly a body takes on the water's own speed, for the water it displaces. A body that floats at rest settles at this rate; a dense one sinking through the water is slowed less, as a stone falls through water a cork would stop in. Fast motion is slowed harder still (form drag, with the square of the speed). |
| **Spin drag** | Per second, at full submersion: extra damping on tumbling, over what the water's drag on every part of the body already gives. |
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
