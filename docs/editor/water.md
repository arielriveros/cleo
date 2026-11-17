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
| **River** | A smooth spline through its points, listed upstream to downstream. Each point has its own **Width**, **Depth** and **Flow speed**, easing from one point to the next; the channel is deepest and fastest on its centre line and shallow and slow at the banks. The surface follows the points' heights and never rises on the way down: a point drawn higher than the one before it is taken at that one's height. This is the river as drawn; a **Flow bake** runs its water over the ground itself. |
| **Lake** | A level surface at the node's height inside the smooth closed outline through its points, **Depth** deep. |
| **Ocean** | A level surface at the node's height with no shore unless you give it an **Extent**. Open water lets the wind build the longest and tallest waves. |
| **Pool** | A level block of water centred on the node, **Size** big: a tank, a fountain, a flooded room. Its top face is the surface. |
| **Size** | A pool's width, depth and length in metres, before the node's scale. |
| **Depth** | A lake's or ocean's depth below the surface, metres. Where the landscape is higher, it is the floor. |
| **Extent** | Metres the ocean reaches each way from the node. 0: endless, to the horizon. |
| **Flows from** | The Water node a river starts in: a lake it drains, a river it branches from. The river never stands higher than that water: a start drawn above it is taken at its surface. |
| **Flows into** | The Water node a river ends in: a lake, the ocean, another river. The river never runs lower than that water: where it is drawn under it, that water backs up the channel, and the river runs on into it. |
| **Position** | Where a point is: on a river, its centre line at the surface; on a lake, a point of the outline (the lake's level is the node's height). |
| **Width** | Metres from bank to bank at a river point. |
| **Flow speed** | Metres per second downstream at a river point: how fast the river carries what floats. |
| **Carve landscape** | A river's or lake's bed is dug into the landscape when the **Carve landscape** button is pressed: the bed inside the water and a sloped bank outside it. It only ever lowers the ground, and the carve is one undo step. |
| **Bank width** | Metres the carved bank slopes over, from the water's edge back up to the ground. |
| **Dig deeper** | Metres the carve digs below the water's own depth. |

### Connecting water

Set a river's **Flows into** to a lake, the ocean, a pool or another river and it runs on into that water:
its surface comes down to that water's level and never under it, so the river meets the lake at the lake's
level and the lake backs up the last of its channel. **Flows from** does the same for the river's start, for
a river that drains a lake: it starts no higher than the lake stands. In the viewport, dropping a river's
first or last point on another Water node's water connects it, and dragging it back out lets go.

Where the river runs into what it joins, the other water is the water: it draws the surface there and buoys
what floats, so a log drifting out of the river mouth is carried into the lake without being lifted twice.
The mouth is a shore to neither: no shore foam grows across it, and the lake's waves do not die down there.
A river that runs to the sea carries what floats all the way down: the sea takes over where its water really
stands, at the beach, not before. Move the lake and the river's mouth follows it.

Water joined this way is one system: a [flow bake](#flow-bake) simulates all of it together, so the current
runs from a river into its lake, across it and out down the river that drains it.

## Surface

How the water looks, from a **Water material**: pick one from the library (or make one with **+ New
material**), and edit it right here; a linked material's edits reach every Water node drawing with it.
With none, the water takes the default clear-lake look. The menu beside the picker applies a look
(clear lake, tropical lagoon, alpine river, murky swamp, open ocean, swimming pool).

The surface is single-layer water: what is under it is seen through it, bent by the waves and dimmed and
tinted by the water it crosses, with caustics on the bed; it reflects the scene (screen-space) over the sky;
and foam gathers on the shore, on breaking crests and in rapids, drawn as foam lies on water: a few broken
strands where there is a little, a web with round holes where there is more, white rafts of bubbles where it
is thick. Rain from a Weather volume rings it, snow
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
| **Ripples** | Strength of the waves under a metre long: the ripples the wind raises on the waves, and on running water the ripples the current raises, carried along with it and busiest where the water boils. 1 is the wind's own; floating bodies do not feel them. |
| **Foam size** | Metres across the piece of web the foam is drawn from: its widest holes are about a seventh of that, its bubbles a hundredth. |
| **Flow** | How far the waves, the foam and the caustics ride the current, so a river visibly runs: 1 carries them at the water's own speed. Floating bodies ride the waves where the surface draws them. |
| **Churn** | How much fast water lightens and clouds, as churned water does: a rapid reads pale against the dark, clear pool below it, and water with foam on it is milky between the foam's strands. 0: speed does not show in the colour. |
| **Live waves** | How tall the simulated waves on flowing water stand round the camera (see Live waves, below): the boil of fast water, the wake below every stone, waves standing below a drop. 0: none, and with no river asking for them nothing is simulated. |
| **Foam colour** | The colour of the foam. |
| **Shore foam** | Metres of foam along the shore and in thin water, with surf lines running in; on an ocean, the foam of its breaking surf. |
| **Crest foam** | Foam on breaking wave crests. |
| **Rapids foam** | Foam where the water runs fast or drops: rapids, weirs, waterfalls. With a flow bake it is made where the bake found the water white and carried by the current: round the camera it trails from each stone of the bed in a streak that fades over a few seconds, broken into lace; farther off it is the bake's own foam, streaked along the flow. Never a solid white sheet, and gone where the water is nearly still. |
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

A simulation of the water itself, the way Unreal's baked river simulation works: **Bake flow** runs the
shallow-water equations over the ground until the water settles, and every water in the system then draws
what was found: where the water really stands and how high, currents that bend with the banks and round a
rock, wakes and eddies behind it, water speeding over a shallow bar and piling up before a narrows, and foam
where it tumbles, trailing off downstream. Floating bodies ride the baked water too: its surface and its
currents carry them. The bake runs in the background while the editor keeps drawing; **Cancel** stops it.
Without a bake each water draws as it was drawn. The bake is saved with the project and published with the
game.

One press bakes the whole system: everything joined to this water through **Flows from** and **Flows into**,
on one grid, so a river's water reaches its lake, crosses it and leaves down the river that drains it. An
endless ocean is where a system ends: it is held at its level, and two rivers that reach the same sea are two
systems.

What it simulates:

- **The ground decides where the water goes.** The bed is the landscape, and nothing holds the water at the
  height or along the line it was drawn at. A river's water is free to run anywhere in a corridor round its
  course (twice its width either side, between 8 and 40 m); a lake's wherever the ground beside it lies under
  its level. A river drawn across ground with no channel runs off downhill, and the bake says so: press
  **Carve landscape** (with **Dig deeper**, for a channel that holds more than the drawn depth) or draw the
  river where the ground runs. Only where there is no landscape under a water does its own drawn bed stand in
  for the ground.
- **Static colliders are obstacles.** A Collider with no mass standing out of the water is a wall the water
  goes round; one under the surface raises the bed, and the water speeds over it. Colliders with mass (what
  floats or falls) are not part of the bake.
- **A river brings its own water.** A river that starts in no other water rises at its first point, with the
  water that point carries (width × depth × flow speed). From there the slope and the bed's roughness decide
  how fast and deep it runs. On steep ground a stream tumbles from step to pool instead of sheeting down: a
  natural bed (a **Bed roughness** of 0.025 and up) is never taken smoother there than mountain streams
  measure. A river that runs into nothing drains at its end.
- **A lake finds its own level.** A lake with a river in and a river out is not held where it was drawn: it
  stands where its outlet lets it, and the flow crosses it from one mouth to the other. A lake with no river
  out takes what comes without rising; a lake with a river out and none in feeds it.
- **A hollow on the way fills** before the water runs on. One too big to fill in the time a bake allows is
  reported: make it a lake.
- **Foam is made and carried.** It is made where the water loses its energy: tumbling down a steep bed, at
  the foot of a drop, in the shear beside a jet and the eddy behind a rock. The smooth tongue over a weir's
  lip makes none; a short hard drop makes more than a long steady chute. It is carried downstream by the
  current and fades over a few seconds, so a torrent comes out streaked: white where it falls, clear in its
  pools.
- **The banks are the ground's.** The baked surface is drawn on a little way under the dry ground beside it,
  so the waterline is where the water meets the bank, not the outline of the bake's cells.

When the bake is done the card says how it went: whether the water settled (what flows in is what flows
out) and after how long; how much water left its course, and where; any hollow still filling, and where; and
a lake that stands at another level than it was drawn at. Water that leaves its course is the thing to fix:
the river is drawn where the ground does not hold it.

Moving or editing any water of the system, the landscape under it or a static collider in it makes the bake
stale, and every water of the system draws as drawn again until the next bake; the Console says so. Editing
the waves, the look or the carve settings does not.

| Field | What it does |
|---|---|
| **Bake resolution** | Cells along the longest side of everything baked together: finer catches narrower channels and smaller rocks, and takes longer (twice as fine is four times the cells and eight times the time). A river wants half a dozen cells across it; the card warns when it has fewer. |
| **Bed roughness** | Manning's roughness of the bed: 0.01 smooth concrete, 0.03 a natural channel, 0.1 a weedy, bouldery one. The rougher, the slower and deeper the water runs. A natural bed (0.025 and up) is never taken smoother than a stream on its slope measures; a smoother one is a flume, and runs as fast as its slope lets it. |

## Waves

A lake's, a pool's and the sea's waves are raised by the wind; a river's by its own current (below).

Waves raised by the wind, as many as forty of them from the longest the wind builds down to ripples a
centimetre and a half long, each one shorter than the last and running at its own natural speed. Each has a
sharp crest over a broad trough, as wind waves do; they run in scattered directions, their crests bent and
broken into short segments; and the long waves gather the short ones onto their crests, so the sea reads as
water rather than as a pattern. The waves are afl_ext's (from the Shadertoy "Very fast procedural ocean", MIT
licence); the crest bending follows TDM's "Seascape".

The sea is the one that wind raises: its height is the significant wave height measured for that wind over that
much open water (the **Fetch**), and its roughness, how much the surface tilts, is what Cox and Munk measured
from the sun's glitter on real seas. A short fetch raises a young sea of short, steep, choppy waves; a long one
the long swell of the open ocean. A lake or pool limits them to what its size lets build, and an endless ocean
lets them grow fully developed unless **Fetch** says otherwise. Floating bodies ride the same waves the
surface draws, all those a metre long or more.

A river's waves are its current's, whatever the wind: the chop and standing waves fast water raises over its
bed. The longest is the wave that can stand still against the flow (60 cm long in water running 1 m/s, 2.5 m
at 2 m/s), their height a share of the height the water's speed could lift it (centimetres at 1 m/s, a hand's
width at 3), and they run every way. Each stretch has the waves of its own speed: tall in a rapid, calm in a
pool, with the baked current where there is a flow bake and the drawn **Flow speed** where there is none.
They ride downstream with the water, and the banks calm them within a stride. A river shows only the fields
that shape them: **Height**, **Wave speed**, **Shore fade** and the swell.

### Live waves

Round the camera, flowing water also carries waves that are simulated every frame, not drawn from a formula:
real surface waves on the baked current. The model is Jeschke and Wojtan's (2023): the flow bake is the bulk
of the water, and on it ride waves that obey water's own rule, each wavelength running at the speed its length
and the depth under it give, carried downstream by the current. That rule is what makes water in a river look
like a river: a wave that runs upstream exactly as fast as the current runs down stays where it is. So the
waves are raised where a river raises them, and then left to the water:

- **Stones.** The bed is taken to have stones a foot or two across just under the surface, one to every ten
  square metres or so, too small for the bake's grid. The water rides up over each and drops behind it, and in
  fast water each leaves the V of a wake standing below it. They are not drawn: the bed shows none.
- **Turbulence.** Fast water over a rough bed boils: a surface that heaves at random, carried with the
  current, hardest where the bake found the water losing its energy, in riffles with glassy runs between.
- **The bulk flow's turns.** Where the baked current speeds up or slows down sharply (the lip of a drop, the
  foot of one) the surface cannot follow, and a train of waves stands below.

A wave that steepens past what water holds breaks: it is damped, and leaves foam. The foam the stones and the
boil churn up, where the bake found the water white, is carried by the same current and fades over a few
seconds, so it lies in streaks. The surface is lifted by these waves, lit by their slopes, and takes its
**Rapids foam** from them; **Live waves** on the Water material sets their height, and 0 turns them off.

What to know:

- They cover a square about 77 m across, set a little ahead of the camera, in cells of 15 cm. Water that
  comes into it starts level and takes a second or two to be raised. Past it the river draws
  its formula waves and the bake's own foam, as before; the join is faded over the last few metres.
- A lake or pool joined to a river is in the same simulation, so the river's waves and foam run out into it.
  An ocean keeps its own waves.
- With no flow bake there is still a current to ride (the drawn **Flow speed**) and the stones still raise
  wakes, but there is no foam to carry: the bake is what says where water turns white.
- **Floating bodies do not feel them.** Buoyancy rides the river's formula waves and the baked current, as
  before: these are for the eye.
- They run at sixty steps a second, two a frame at most: under 30 frames a second they slow down rather than
  cost more.
- They need float render targets that can be filtered. A device without them draws the river as before.

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
| **Height** | Multiplies the wave height the wind gives, or on a river the height its current gives. |
| **Choppiness** | How hard the long waves crowd the short ones onto their crests: 0 an even chop, 1 the small waves bunched on every crest. |
| **Wave speed** | How fast the waves and ripples run against their natural pace. 1 is real: a wave runs as fast as its length makes it (a 40 m ocean swell at 8 m/s, a lake's 1 m chop at 1.2 m/s). Below 1, a calmer, slower sea. Floating bodies ride the waves at the same pace. |
| **Follow wind** | The scene's Wind node raises and calms the waves: their height follows its speed against **Wind speed**, squared as a sea's does, up to twice as tall. Their length and direction stay as shaped. A sea set to a stronger wind than the Wind node blows (offshore winds often are) is flattened by it: leave this off there. A river's waves do not follow the wind. |
| **Shore fade** | Metres from a shore over which the waves die down. A river's banks calm its waves within 1.5 m at most. |
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
