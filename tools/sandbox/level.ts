// The Sandbox course: a gray-box test level for locomotion. Metres; +Z is ahead of the player's spawn, +X its left.
//
//   ramps        10, 20, 30, 40 degrees, each up to a 1.5 m platform you can drop off the far side of
//   stairs       15 cm and 20 cm risers (3D physics has no step-up: each flight rides on an invisible ramp)
//   bumps        a strip of small tilted slabs, for foot placement
//   platforms    0.3, 0.6, 1.0, 2.0 and 3.5 m, the tall ones reached by a ramp: jump on, drop off
//   gap          two 1 m blocks 2 m apart, for a running jump
//   pillars, wall  close to the start, for the camera's collision
//   props        loose rigid bodies over all of it: crates, barrels, balls and planks to push, knock over and roll
//
// Pure data: build.ts turns each piece into a collider with its mesh under it, then folds the static ones into one
// Static Collision collider with the engine's own merge pass; the props stay bodies of their own.

export type Material = 'floor' | 'block' | 'accent'

export type Piece =
    | { kind: 'box'; name: string; size: [number, number, number]; position: [number, number, number]; rotation?: [number, number, number]; material: Material }
    | { kind: 'ramp'; name: string; size: [number, number, number]; position: [number, number, number]; yaw?: number; material: Material }
    | { kind: 'stairs'; name: string; steps: number; size: [number, number, number]; position: [number, number, number]; yaw?: number; material: Material }
    | { kind: 'cylinder'; name: string; radius: number; height: number; position: [number, number, number]; material: Material }

/**
 * A loose rigid body: a unit box, ball or cylinder scaled to `size` (a ball's must be uniform), resting where it
 * is put. `name` is its kind: every prop of one name is the same template.
 */
export interface Prop {
    name: PropKind
    position: [number, number, number]
    /** Degrees. A barrel lying down is [0, yaw, 90]. */
    rotation?: [number, number, number]
}

export type PropKind = 'Small Crate' | 'Crate' | 'Large Crate' | 'Barrel' | 'Ball' | 'Big Ball' | 'Plank'

/** What each kind of prop is: its shape, size (m), mass (kg) and how it bounces and rolls. */
export const PROP_KINDS: Record<PropKind, {
    shape: 'box' | 'sphere' | 'cylinder'; size: [number, number, number]; mass: number
    restitution?: number; angularDamping?: number; material: 'prop' | 'propAccent'
    /** Whether it blocks the camera: small things do not pull the camera in. */
    camera: boolean
}> = {
    'Small Crate': { shape: 'box', size: [0.5, 0.5, 0.5], mass: 8, material: 'prop', camera: false },
    'Crate': { shape: 'box', size: [0.8, 0.8, 0.8], mass: 25, material: 'prop', camera: true },
    'Large Crate': { shape: 'box', size: [1.2, 1.2, 1.2], mass: 80, material: 'prop', camera: true },
    'Barrel': { shape: 'cylinder', size: [0.6, 0.9, 0.6], mass: 25, material: 'propAccent', camera: false },
    'Ball': { shape: 'sphere', size: [0.5, 0.5, 0.5], mass: 3, restitution: 0.5, angularDamping: 0.05, material: 'propAccent', camera: false },
    'Big Ball': { shape: 'sphere', size: [1, 1, 1], mass: 8, restitution: 0.4, angularDamping: 0.05, material: 'prop', camera: false },
    'Plank': { shape: 'box', size: [2.4, 0.1, 0.3], mass: 10, material: 'prop', camera: false },
}

/** Where a prop of `kind` rests on a surface at height `floor`: its centre, half its standing height above. */
const on = (kind: PropKind, x: number, floor: number, z: number, lying = false): [number, number, number] => {
    const k = PROP_KINDS[kind]
    const h = lying && k.shape === 'cylinder' ? k.size[0] : k.size[1]
    return [x, floor + h / 2, z]
}

/**
 * The props, scattered over the course. Each rests exactly on what is under it, so nothing moves until it is
 * touched; none stands where the locomotion tests run (the open ground round [32, -30], the drop column round
 * [35, 30], the run at the wall from [-10, -7.6], and 4 m round the spawn).
 */
export function props(): Prop[] {
    const out: Prop[] = []
    // Beside the start: something to walk into straight away.
    out.push({ name: 'Small Crate', position: on('Small Crate', 4.6, 0, 1.6) })
    out.push({ name: 'Small Crate', position: on('Small Crate', 5.3, 0, 2.6), rotation: [0, 25, 0] })
    out.push({ name: 'Crate', position: on('Crate', 6.2, 0, 0.6), rotation: [0, 10, 0] })
    out.push({ name: 'Barrel', position: on('Barrel', 5.0, 0, -1.4) })
    // On the platforms, to knock off: a crate on the 1 m one, balls on the 2 m one.
    out.push({ name: 'Crate', position: on('Crate', 19, 1, 9.5) })
    out.push({ name: 'Ball', position: on('Ball', 23.0, 2, 9.0) })
    out.push({ name: 'Ball', position: on('Ball', 24.0, 2, 10.0) })
    // On the 20 and 30 degree ramps' tops, to send rolling down them.
    out.push({ name: 'Big Ball', position: on('Big Ball', -16, 1.5, 12.6) })
    out.push({ name: 'Big Ball', position: on('Big Ball', -20, 1.5, 11.2) })
    // A barrel lying at the foot of the 15 cm stairs.
    out.push({ name: 'Barrel', position: on('Barrel', -5, 0, 4.4, true), rotation: [0, 0, 90] })
    // Behind the wall: a 3-2-1 crate pyramid to topple, and two barrels lying beside it.
    const c = PROP_KINDS['Crate'].size[0], gap = 0.02
    for (let row = 0; row < 3; row++) for (let i = 0; i < 3 - row; i++)
        out.push({ name: 'Crate', position: on('Crate', -22 + (i - (2 - row) / 2) * (c + gap), row * (c + 0.004), -11) })
    out.push({ name: 'Barrel', position: on('Barrel', -19, 0, -12.2, true), rotation: [0, 15, 90] })
    out.push({ name: 'Barrel', position: on('Barrel', -19.2, 0, -13.2, true), rotation: [0, -10, 90] })
    // Big things to lean on, out on the open ground past the ramps.
    out.push({ name: 'Large Crate', position: on('Large Crate', -28, 0, -2), rotation: [0, 20, 0] })
    out.push({ name: 'Large Crate', position: on('Large Crate', -30, 0, 1.5) })
    out.push({ name: 'Big Ball', position: on('Big Ball', -27, 0, -18) })
    // Planks by the gap.
    out.push({ name: 'Plank', position: on('Plank', 3.2, 0, -8), rotation: [0, 20, 0] })
    out.push({ name: 'Plank', position: on('Plank', 3.6, 0, -9.2), rotation: [0, -15, 0] })
    return out
}

const DEG = Math.PI / 180

export function course(): Piece[] {
    const out: Piece[] = []
    out.push({ kind: 'box', name: 'Ground', size: [120, 1, 120], position: [0, -0.5, 0], material: 'floor' })

    // Ramps: a ramp rising toward +Z onto a 1.5 m platform, one lane per angle.
    const rampHeight = 1.5
    ;[10, 20, 30, 40].forEach((angle, i) => {
        const x = -12 - i * 4, run = rampHeight / Math.tan(angle * DEG), z0 = 6
        out.push({ kind: 'ramp', name: `Ramp ${angle}`, size: [3, rampHeight, run], position: [x, rampHeight / 2, z0 + run / 2], material: 'block' })
        out.push({ kind: 'box', name: `Ramp ${angle} Top`, size: [3, rampHeight, 4], position: [x, rampHeight / 2, z0 + run + 2], material: 'block' })
    })

    // Stairs: 30 cm treads.
    ;[[0.15, 10, -5], [0.2, 8, -1]].forEach(([rise, steps, x]) => {
        const h = rise * steps, d = 0.3 * steps, z0 = 6
        out.push({ kind: 'stairs', name: `Stairs ${Math.round(rise * 100)} cm`, steps, size: [2.5, h, d], position: [x, h / 2, z0 + d / 2], material: 'block' })
        out.push({ kind: 'box', name: `Stairs ${Math.round(rise * 100)} cm Top`, size: [2.5, h, 3], position: [x, h / 2, z0 + d + 1.5], material: 'block' })
    })

    // Bumps: small slabs, tilted, on a 1 m grid with a fixed pattern.
    let seed = 7
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    for (let row = 0; row < 8; row++) for (let col = 0; col < 3; col++) {
        const tilt = 6 + rand() * 12
        out.push({
            kind: 'box', name: `Bump ${row * 3 + col + 1}`, size: [0.9, 0.2 + rand() * 0.15, 0.9],
            position: [3 + col * 1.1, 0, 6 + row * 1.1],
            rotation: [(rand() - 0.5) * 2 * tilt, rand() * 90, (rand() - 0.5) * 2 * tilt], material: 'accent',
        })
    }

    // Platforms: jump onto the low ones, climb the ramp behind the tall ones and drop off the front.
    ;[0.3, 0.6, 1.0, 2.0, 3.5].forEach((h, i) => {
        const x = 10 + i * 4.5, z = 9.5
        out.push({ kind: 'box', name: `Platform ${h} m`, size: [3, h, 3], position: [x, h / 2, z], material: 'block' })
        if (h >= 1) {
            const run = h / Math.tan(25 * DEG)
            // Rising toward -Z, from behind: turned half round.
            out.push({ kind: 'ramp', name: `Platform ${h} m Ramp`, size: [3, h, run], position: [x, h / 2, z + 1.5 + run / 2], yaw: 180, material: 'block' })
        }
    })

    // The gap: up a ramp onto a 1 m block, a 2 m gap, a second block.
    const gapH = 1
    const gapRun = gapH / Math.tan(20 * DEG)
    out.push({ kind: 'ramp', name: 'Gap Ramp', size: [3, gapH, gapRun], position: [0, gapH / 2, -3 - gapRun / 2], yaw: 180, material: 'block' })
    out.push({ kind: 'box', name: 'Gap Near', size: [3, gapH, 6], position: [0, gapH / 2, -3 - gapRun - 3], material: 'block' })
    out.push({ kind: 'box', name: 'Gap Far', size: [3, gapH, 6], position: [0, gapH / 2, -3 - gapRun - 6 - 2 - 3], material: 'block' })

    // Pillars and a wall near the start, for the camera.
    ;[[8, -5], [11, -7], [14, -5]].forEach(([x, z], i) =>
        out.push({ kind: 'cylinder', name: `Pillar ${i + 1}`, radius: 0.4, height: 4, position: [x, 2, z], material: 'accent' }))
    out.push({ kind: 'box', name: 'Wall', size: [8, 3, 0.4], position: [-10, 1.5, -6], material: 'accent' })
    return out
}

/** Where the player starts, and facing (yaw degrees; 0 = +Z). */
export const SPAWN = { position: [0, 0.02, 0] as [number, number, number], yaw: 0 }
