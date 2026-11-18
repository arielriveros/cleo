# Vehicles

*(unreleased)*

A vehicle is one rigid body carried by its wheels. The body is a [Collider](physics.md#collider) with mass:
the **chassis**. A **Vehicle** node stands in it, and **Wheel** nodes under the Vehicle are its wheels.

The wheels are not bodies of their own. Each physics step every wheel finds the ground below it, and its
spring, damper and tyre push the chassis at the point where it touches. Jolt, PhysX, Unreal's Chaos, Unity
and Bullet all build vehicles this way. Wheels made as separate bodies joined to the chassis tunnel through
thin ground, bounce on mesh edges and sag as the solver softens the joints. Virtual wheels stay steady at
any speed.

You build a vehicle step by step, and you decide what it is: how many wheels, what powers them, and what it
looks like.

1. **Add ▸ [Simulation](scene-authoring.md#simulation) ▸ Vehicle.** This gives a 1200 kg chassis (a Collider
   with a box shape and no mesh) holding an empty Vehicle node, which is selected.
2. **Add wheels** from the Vehicle's [Wheels](#wheels) list: one at a time, or an axle (a left and a right
   wheel) at a time. Each goes to the chassis's next free corner, with no mesh. Move them where you want them.
3. **Choose its [Drive](#drive):** none (a trailer or a cart), an engine and gearbox, or an electric motor in
   each wheel.
4. **Put your meshes** under the chassis (its body) and under each Wheel (its tyre). A mesh under a Wheel spins,
   steers and rides the suspension with it.

Or start from one of the [Presets](#presets) in the Vehicle panel's **Presets ▾** menu: Car, Sports Car,
Kart, Truck, Bus, Off-road, Bike or Trailer. A preset lays the vehicle out for you, wheels and chassis
included, and keeps the meshes you have already put under its wheels.

Press Play: with **Player input** on, **Move** drives and steers and **Jump** holds the hand brake.

The scripting side is in [Motion and physics](../scripting/motion-and-physics.md#vehicles).

## Presets

The Vehicle panel's **Presets ▾** menu lays the vehicle out as one of these. Each sets the Vehicle's settings,
its wheel layout and its chassis's mass and box:

| Preset | Chassis | Wheels | Drive |
|---|---|---|---|
| **Car** | 1200 kg, 1.8 × 0.6 × 4 m | Four; the front axle steers 30°, the rear one drives and holds the hand brake | Engine, 500 N·m, five gears, limited slip |
| **Sports Car** | 1300 kg, 1.9 × 0.5 × 4.4 m | Four; grippy, stiffly sprung, short travel | Engine, 700 N·m to 8000 RPM, six gears, rear-wheel drive |
| **Kart** | 150 kg, 1.0 × 0.2 × 1.5 m | Four small ones, very stiff | Electric motors in the rear wheels, to 60 km/h |
| **Truck** | 8000 kg, 2.4 × 1.2 × 8 m | Six on three axles; the front steers, both rear axles drive | Engine, 2000 N·m to 2800 RPM, six low gears |
| **Bus** | 12000 kg, 2.5 × 1.6 × 11 m | Four; a long wheelbase, softly sprung | Engine, 1800 N·m, rear-wheel drive |
| **Off-road** | 900 kg, 1.7 × 0.5 × 3.2 m | Four big ones; long, soft suspension, looser grip | Engine, 450 N·m, all-wheel drive, limited slip |
| **Bike** | 220 kg, 0.35 × 0.6 × 1.8 m | Two in line; the front steers, the rear drives | Engine, 120 N·m to 10000 RPM; [leans](#lean) into turns |
| **Trailer** | 600 kg, 1.6 × 0.6 × 2.4 m | Two on one axle, none steering | None; a [hitch](#hitch) point at its tongue. Set **Towed by** to the vehicle that pulls it |

Applying a preset to a vehicle that already has wheels keeps them, and the meshes under them. The first wheel
takes the preset's first place, the second its second, and so on: each moves to its new place, its mesh with
it, and takes the preset's settings. Wheels it still lacks are added, with no mesh. Wheels beyond the preset's
count are removed when nothing is under them; one that carries a mesh is kept, and the panel says so. A wheel
you renamed keeps its name.

A preset never chooses what the vehicle is hitched to, and only the Trailer sets **Player input** (off).
Applying one is one undo step. From a script: `vehicle.applyPreset('bike')`.

## Vehicle

The Vehicle node holds its wheels, its drive and its handling. The vehicle faces the node's **+Z**, with
**+Y** up. Its right is **-X**: in the engine, a right turn is a negative angle.

### Wheels

The Wheel nodes under the Vehicle, one row each: click a row to select that wheel, or its **✕** to remove it.
Under the list, the wheel button adds one wheel and the axle button adds two, a left and a right. They fill the
chassis's corners in order (measured from the chassis's box): left then right, the front axle first, then the
back, then each further axle behind the last. The front axle steers. A new wheel has no mesh.

### Drive

What powers the vehicle:

| Drive | Meaning |
|---|---|
| **None** | Nothing drives it. It rolls, steers and brakes: a trailer, a cart, something pushed or towed. |
| **Engine** | An engine and an automatic gearbox, through differentials to the wheels marked **Driven**. The [Engine](#engine) and [Gearbox](#gearbox) settings appear. |
| **Motors** | An electric motor in each wheel, with its own torque and top speed, set on the wheel ([Motor](#motor)). No gearbox. A wheel with no torque only rolls. |

The motors all follow the one throttle: each pushes with its own torque up to its own top speed, but they cannot
be driven separately (no tank steering).

### Driving

Who drives it, and how the throttle behaves.

| Setting | Meaning |
|---|---|
| **Player input** | Drive it from the player's input. **Move** steers (x) and drives (y); **Jump** holds the hand brake. Off: a script sets `throttle`, `steer`, `brake` and `handBrake`. |
| **Auto reverse** | Holding the throttle against the way it rolls brakes first, then reverses once it has nearly stopped, like a road car's pedals. Off: a backward throttle selects reverse straight away. |

### Engine

How much the engine pulls, and over what speed range.

| Setting | Meaning |
|---|---|
| **Torque** | N·m at the peak of the engine's torque curve. |
| **Idle RPM** / **Redline RPM** | The engine's speed range. Past the redline it gives no torque. |

### Gearbox

The automatic gearbox and the differentials behind it.

| Setting | Meaning |
|---|---|
| **Shift up** / **Shift down** | The RPM at which the automatic gearbox changes up and down. It does not change up while a driven wheel spins. |
| **Shift time** | Seconds a gear change takes, with no torque through the clutch. |
| **Final drive** | The differentials' ratio. |
| **Reverse ratio** | The reverse gear's ratio. |
| **Clutch** | How hard the clutch couples the engine to the wheels. A heavy vehicle needs a strong one: a weak clutch slips under the load. Only Jolt models the clutch; on Rapier and Cannon it couples at once. |
| **Gears** | The forward gears' ratios, first gear first. |
| **Limited slip** | Limited-slip differentials send torque to the wheel that grips. Off: open differentials, where a spinning wheel takes all the torque. |

### Handling

How it leans and what its wheels feel the ground with.

| Setting | Meaning |
|---|---|
| **Anti-roll** | How hard each axle resists the body rolling in a turn, in N/m. `0` for none. |
| **Max pitch / roll** | Most the chassis may tip from upright, in degrees. `180` lets it roll over. |
| **Ray** / **Sphere** / **Cylinder** | What each wheel finds the ground with: a ray down its centre, a sphere, or its own cylinder, which follows kerbs and bumps by the tyre's real shape. Only Jolt casts a sphere or a cylinder; the Cannon and Rapier backends always cast a ray. |

### Lean

For a vehicle on two wheels in line, a motorcycle: **Lean into turns** holds it upright and leans it into
turns. The lean it aims for balances the turn its steering asks for at its speed, up to **Max lean**; **Lean
spring** and **Lean damping** set how firmly it gets there. It also narrows the steering as speed rises, to
what that lean can hold. Without it, a vehicle on two wheels in line falls over.

### Hitch

What tows it, for a trailer. **Towed by** names the vehicle that pulls it: pick it, or drop its chassis from
the scene tree. **Hitch point** is where it is coupled, in the Vehicle's frame (a trailer's tongue, ahead of its
chassis). In Play a ball joint joins the two chassis at that point, where it is when the scene starts, so place
the trailer with its hitch point at the towing vehicle's tow ball. With the colliders overlay on, a red cross
marks the hitch point.

### Live

While Play runs: speed, RPM, gear, and how many wheels are on the ground.

Wheels side by side (within 30 cm along the vehicle) share an **axle**. A driven axle gets a differential,
and each axle with two wheels gets an anti-roll bar.

## Wheel

Place a Wheel at the wheel's centre with its suspension fully **extended**: the wheel hanging free. In
Play it is pushed up from there as the vehicle settles on its springs. Put the wheel's mesh under it. While
the game runs, the Wheel node spins with the wheel, turns with its steering and rides its suspension, and
the mesh goes with it.

### Tyre

The tyre's size and how well it grips.

| Setting | Meaning |
|---|---|
| **Radius** / **Width** | The tyre's size, in metres. |
| **Grip** | Scales the tyre's friction. `1` is a road tyre on tarmac; below `1` is worn, or on a slippery surface. The ground's own friction counts too. |

### Suspension

The spring that carries the wheel: how far it moves and how it bounces.

| Setting | Meaning |
|---|---|
| **Travel** | How far the wheel moves up from where it is placed before the suspension bottoms out. |
| **Length** | From where the spring is attached down to the wheel's centre at full extension. At least the travel. The spring is attached this far above the wheel. |
| **Frequency** | How fast the spring bounces, in Hz: 1–2 for a road car, 2–3 for a sports car, more for a kart. It is set on the weight the wheel carries, so a heavier vehicle needs no stiffer springs. |
| **Damping** | `0` keeps bouncing, `1` settles without overshoot. |

### Steering and brakes

Whether the wheel steers or is driven, and how hard it brakes.

| Setting | Meaning |
|---|---|
| **Steer angle** | Steering lock, in degrees. `0` for a wheel that does not steer. |
| **Brake** / **Hand brake** | N·m at a full press. A hand brake of `0` leaves the wheel free. |
| **Driven** | With the Engine drive: the engine turns this wheel. |

### Motor

With the Motors drive: this wheel's own electric motor.

| Setting | Meaning |
|---|---|
| **Torque** | N·m at full throttle. `0`: the wheel has no motor and only rolls. |
| **Top speed** | The fastest the motor turns the wheel, as the speed of the tyre's rim in km/h. |

With **Colliders** on in the [debug overlays](scene-authoring.md#debug-overlays), each wheel draws in red:
its tyre as a circle, and its suspension as a line up to where it is attached. The tick on the line marks
where the wheel bottoms out.

## Physics backends

Every backend builds the vehicle from the same description, using its own native vehicle:

- **Jolt** uses its `VehicleConstraint`, which simulates everything itself: wheel casts, the suspension as
  a soft constraint, tyre slip, and the engine, gearbox and differentials.
- **Cannon** and **Rapier** use their own raycast vehicles, ports of Bullet's. These find the ground,
  spring the suspension and solve the tyres. The engine adds what they lack: the engine and gearbox, wheel
  spin, brakes as torques, anti-roll bars and the hand brake's hold on a slope.

One tuning drives about the same on all three. Ride height matches to within a centimetre, braking
distance to about 15%, and top speed after a few seconds to about 25%. The lean controller is the same on
all three. Only Jolt casts a sphere or a cylinder and models the clutch. See
[Physics backends](../reference/physics-backends.md#vehicles).
