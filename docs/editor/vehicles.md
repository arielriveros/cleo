# Vehicles

*(unreleased)*

A vehicle is one rigid body carried by its wheels. The body is a [Collider](physics.md#collider) with mass:
the **chassis**. A **Vehicle** node stands in it, and **Wheel** nodes under the Vehicle are its wheels.

The wheels are not bodies of their own. Each physics step every wheel finds the ground below it, and its
spring, damper and tyre push the chassis at the point where it touches. Jolt, PhysX, Unreal's Chaos, Unity
and Bullet all build vehicles this way. Wheels made as separate bodies joined to the chassis tunnel through
thin ground, bounce on mesh edges and sag as the solver softens the joints. Virtual wheels stay steady at
any speed.

Add one from the Add catalog's [Simulation](scene-authoring.md#simulation) category: **Vehicle** makes a car
to start from. It has a 1200 kg box chassis, the Vehicle node, and four Wheels, each with a cylinder for a
tyre. The rear wheels drive and hold the hand brake, the front ones steer, and **Player input** is on.
Press Play and drive it with **Move**; **Jump** holds the hand brake.

The scripting side is in [Motion and physics](../scripting/motion-and-physics.md#vehicles).

## Vehicle

The Vehicle node holds the engine, the gearbox and the handling. The vehicle faces the node's **+Z**, with
**+Y** up. Its right is **-X**: in the engine, a right turn is a negative angle.

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
| **Gears** | The forward gears' ratios, first gear first. |
| **Limited slip** | Limited-slip differentials send torque to the wheel that grips. Off: open differentials, where a spinning wheel takes all the torque. |

### Handling

How it leans and what its wheels feel the ground with.

| Setting | Meaning |
|---|---|
| **Anti-roll** | How hard each axle resists the body rolling in a turn, in N/m. `0` for none. |
| **Max pitch / roll** | Most the chassis may tip from upright, in degrees. `180` lets it roll over. Only Jolt applies this. |
| **Ray** / **Sphere** / **Cylinder** | What each wheel finds the ground with: a ray down its centre, a sphere, or its own cylinder, which follows kerbs and bumps by the tyre's real shape. Only Jolt casts a sphere or a cylinder; the Cannon and Rapier backends always cast a ray. |

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
| **Driven** | The engine turns this wheel. |
| **Brake** / **Hand brake** | N·m at a full press. A hand brake of `0` leaves the wheel free. |

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
distance to about 15%, and top speed after a few seconds to about 25%. Only Jolt casts a sphere or a
cylinder and holds **Max pitch / roll**. See [Physics backends](../reference/physics-backends.md#vehicles).
