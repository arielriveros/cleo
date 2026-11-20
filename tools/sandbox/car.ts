// The Sandbox car: build/car/dirty_car.glb ("Dirty car" by 3D Error 404, CC-BY-4.0, via Sketchfab), read and cut
// into what the Car template is made of. Pure data, like level.ts: build.ts turns it into model assets and nodes.
//
// The file is in centimetres, its front +Z, its left +X, its origin on the ground under the middle of the body. It is
// mirrored across its centre line on the way in: the model is right-hand drive (its steering wheel on the right),
// and the Mixamo clips get in on the driver's LEFT. It is scaled as tight round the seated driver as the clips allow
// (CAR_FIT: 5 m long, 1.49 m tall), the hips sat down onto the cushion.
//
//   body, glass  the body (opaque) and the windows (blended): one node each under one Body node (the renderer picks a
//                pass per node, so the two cannot share one mesh); the chassis Collider is one convex hull of the two
//   wheels       one mesh holding all four: cut apart by which corner each triangle is at, each centred on its hub
//                (a Wheel node turns the mesh under it, so each is its own node); the front left one, placed under
//                each Wheel node (turned round on the right)
//   lamps        where the head, tail and reversing lamps are on its front and rear faces

import { mat4 } from 'gl-matrix'
import { readGltf, partsOf, boundsOf } from '../valley/meshes.mjs'
import { localMatrix } from '../exampleKit/fbxImport.mjs'
import { rotateByYaw, yawPoseInvert, yawPoseMul, type YawPose } from '../../src/core/math'

/** The model at its own size (centimetres to metres, mirrored): where the driver's seat and wheel are. */
const NATIVE = {
    /** The top of the driver's cushion, and the roof's lining over it, m above the ground. */
    cushion: 0.575, roof: 1.72,
    /** The steering wheel's grip, its centre (x, y, z). */
    wheel: [0.489, 0.981, 0.715] as const,
}
/** The seated clips (clips.ts carClips): the buttocks this far under the hips, the top of the head this far over them. */
const SEATED = { buttocks: 0.161, head: 0.762 }
/** Between the seated head and the roof's lining, m. */
const HEAD_ROOM = 0.03
/**
 * How far behind the steering wheel's centre the hips sit for the seated clips' hands to meet its grip, m: measured
 * at the model's own size (the hips at z 0.26 with the wheel's centre at 0.715). The character is not scaled with the
 * car, so it stays this far behind whatever size the car is.
 */
const REACH = 0.455
/**
 * How much further back the hips sit so the driver's back is against the seat's backrest, m: the gap between the
 * seated clips' back (the driving clip skinned on the Mannequin) and the backrest's front at the lower back, where
 * it is narrowest (18.7 cm at REACH, measured at CAR_FIT's size). The hands then fall short of the steering wheel by
 * as much, until the clips are reworked for this seat.
 */
const SEAT_BACK = 0.18

/**
 * The car's size and its driver's place, as tight as the seated clips allow: scaled so a seated driver's buttocks are
 * on the cushion and its head HEAD_ROOM under the roof (0.83 of its own size: 5 m long, a big saloon).
 *
 *   size      the scale on the model's own size
 *   seatHips  where the seated hips sit, m above the floor: on the scaled cushion. The seated clips sit them higher
 *             (they are fitted to a taller seat); getting in lowers them the rest of the way (carClips' `seatHips`)
 *   hipsXZ    where they sit in the car's frame, x and z: under the steering wheel, REACH and SEAT_BACK behind it
 */
const SIZE = Math.round((SEATED.buttocks + SEATED.head + HEAD_ROOM) / (NATIVE.roof - NATIVE.cushion) * 100) / 100
export const CAR_FIT = {
    size: SIZE,
    seatHips: NATIVE.cushion * SIZE + SEATED.buttocks,
    hipsXZ: [0.98 * NATIVE.wheel[0] * SIZE, NATIVE.wheel[2] * SIZE - REACH - SEAT_BACK] as [number, number],
}

/**
 * Where a lamp's light goes at the model's own size (m, the left one of each pair: the right one is mirrored), read
 * off the front and rear faces: just off the lens, `inset` in from the bumper's face (the bumpers stand out
 * further). The headlamps are on the grille panel between the bumper and the bonnet; the tail lamp clusters are
 * above the rear bumper at the corners, red outboard and the reversing lamp inboard.
 */
const LAMPS_NATIVE = {
    head: { x: 0.66, y: 0.82, inset: 0.07 },
    tail: { x: 0.90, y: 0.87, inset: 0.05 },
    reverse: { x: 0.58, y: 0.87, inset: 0.05 },
}

/** A lamp's place in the car's frame: `[x, y, z]` of the left one. */
export interface CarLamps {
    head: [number, number, number]
    tail: [number, number, number]
    reverse: [number, number, number]
}

/** The file's centimetres to the car's metres. */
export const CAR_SCALE = 0.01 * CAR_FIT.size

export interface CarPart {
    name: string
    material: number
    positions: Float32Array
    normals: Float32Array
    uvs: Float32Array
    indices: Uint32Array
}

export type Corner = 'FL' | 'FR' | 'RL' | 'RR'

export interface CarWheel {
    corner: Corner
    /** The hub, in the car's frame (its centre as modelled: at rest, on the ground). */
    centre: [number, number, number]
    radius: number
    width: number
}

export interface CarModel {
    body: CarPart
    glass: CarPart
    /** The front left wheel, centred on its hub, its axle along X, its hub facing +X (outward on the left). */
    wheel: CarPart
    wheels: CarWheel[]
    /** Half the body's width below its mirrors, m. */
    halfWidth: number
    /** Its lamps, on its front and rear faces. */
    lamps: CarLamps
    /** The body's bounds. */
    min: [number, number, number]
    max: [number, number, number]
    /** The file's materials (glTF), and its images, by index. */
    materials: any[]
    images: { bytes: Buffer; mime: string }[]
    /** Image index of a material's texture slot, or undefined. */
    textures: any[]
}

/** World matrix of every node of a glTF. */
function worldMatrices(gltf: any): Map<number, mat4> {
    const out = new Map<number, mat4>()
    const visit = (i: number, parent: mat4) => {
        const m = mat4.multiply(mat4.create(), parent, localMatrix(gltf.nodes[i]))
        out.set(i, m)
        for (const c of gltf.nodes[i].children ?? []) visit(c, m)
    }
    for (const r of gltf.scenes[gltf.scene ?? 0].nodes) visit(r, mat4.create())
    return out
}

/** The triangles of `part` that `keep` takes (by their three corners), as a part of their own. */
function subPart(part: CarPart, name: string, keep: (a: number, b: number, c: number) => boolean): CarPart {
    const remap = new Map<number, number>()
    const indices: number[] = []
    const take = (v: number) => {
        let n = remap.get(v)
        if (n === undefined) { n = remap.size; remap.set(v, n) }
        return n
    }
    for (let k = 0; k < part.indices.length; k += 3) {
        const a = part.indices[k], b = part.indices[k + 1], c = part.indices[k + 2]
        if (keep(a, b, c)) indices.push(take(a), take(b), take(c))
    }
    const n = remap.size
    const out: CarPart = { name, material: part.material, positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), uvs: new Float32Array(n * 2), indices: Uint32Array.from(indices) }
    for (const [from, to] of remap) {
        out.positions.set(part.positions.subarray(from * 3, from * 3 + 3), to * 3)
        out.normals.set(part.normals.subarray(from * 3, from * 3 + 3), to * 3)
        out.uvs.set(part.uvs.subarray(from * 2, from * 2 + 2), to * 2)
    }
    return out
}

/** Read the car, mirrored and in metres. */
export function readCar(file: string): CarModel {
    const doc = readGltf(file) as { gltf: any; bin: Buffer }
    const { gltf, bin } = doc
    const world = worldMatrices(gltf)
    const mirror = mat4.fromScaling(mat4.create(), [-CAR_SCALE, CAR_SCALE, CAR_SCALE])
    const parts = partsOf(doc, { transform: (_n: any, i: number) => mat4.multiply(mat4.create(), mirror, world.get(i)!) }) as CarPart[]
    const byMaterial = (re: RegExp) => {
        const found = parts.filter(p => re.test(gltf.materials[p.material]?.name ?? ''))
        if (found.length !== 1) throw new Error(`dirty_car.glb: expected one part with a material like ${re}, found ${found.length}`)
        return found[0]
    }
    const body = { ...byMaterial(/body/i), name: 'Body' }
    const glass = { ...byMaterial(/glass/i), name: 'Glass' }
    const wheelsPart = byMaterial(/wheel/i)

    // The four wheels: each triangle by the corner its middle is at (left is +X, front +Z).
    const cornerOf = (a: number, b: number, c: number): Corner => {
        const p = wheelsPart.positions
        const x = p[a * 3] + p[b * 3] + p[c * 3], z = p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]
        return `${z > 0 ? 'F' : 'R'}${x > 0 ? 'L' : 'R'}` as Corner
    }
    const wheels: CarWheel[] = []
    let canonical: CarPart | null = null
    for (const corner of ['FL', 'FR', 'RL', 'RR'] as Corner[]) {
        const part = subPart(wheelsPart, `Wheel ${corner}`, (a, b, c) => cornerOf(a, b, c) === corner)
        if (part.indices.length === 0) throw new Error(`dirty_car.glb: no wheel at the ${corner} corner`)
        const b = boundsOf([part])
        const centre: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
        wheels.push({ corner, centre, radius: (b.size[1] + b.size[2]) / 4, width: b.size[0] })
        if (corner === 'FL') {
            for (let k = 0; k < part.positions.length; k += 3) for (let a = 0; a < 3; a++) part.positions[k + a] -= centre[a]
            canonical = { ...part, name: 'Wheel Mesh' }
        }
    }

    // Its width along the doors, between the sills and the beltline (the mirrors stand out above it), at its own size.
    const bb = boundsOf([body])
    const p = body.positions
    let halfWidth = 0
    for (let k = 0; k < p.length; k += 3) {
        const y = p[k + 1] / CAR_FIT.size
        if (y > 0.45 && y < 0.95) halfWidth = Math.max(halfWidth, Math.abs(p[k]))
    }

    const images = (gltf.images ?? []).map((img: any) => {
        const view = gltf.bufferViews[img.bufferView]
        const start = view.byteOffset ?? 0
        return { bytes: Buffer.from(bin.subarray(start, start + view.byteLength)), mime: img.mimeType ?? 'image/png' }
    })
    const textures = (gltf.textures ?? []).map((t: any) => t.source)
    return {
        body, glass, wheel: canonical!, wheels, halfWidth,
        lamps: {
            head: [LAMPS_NATIVE.head.x * SIZE, LAMPS_NATIVE.head.y * SIZE, bb.max[2] - LAMPS_NATIVE.head.inset * SIZE],
            tail: [LAMPS_NATIVE.tail.x * SIZE, LAMPS_NATIVE.tail.y * SIZE, bb.min[2] + LAMPS_NATIVE.tail.inset * SIZE],
            reverse: [LAMPS_NATIVE.reverse.x * SIZE, LAMPS_NATIVE.reverse.y * SIZE, bb.min[2] + LAMPS_NATIVE.reverse.inset * SIZE],
        },
        min: bb.min as any, max: bb.max as any,
        materials: gltf.materials, images, textures,
    }
}

/**
 * Where the driver sits, gets in and gets out, in the car's frame, from the seated clips (clips.ts carClips):
 *
 *   Seat         the Character's place while seated: its hips (`seated`, in its own frame) land on the cushion,
 *                facing ahead
 *   Enter Point  where getting in starts: the Seat, back along the root motion getting in carries it by
 *   Exit Point   where getting out ends: the Seat, on along the root motion getting out carries it by
 */
export function seatPoints(seated: YawPose, enter: YawPose, exit: YawPose): { seat: YawPose; enterPoint: YawPose; exitPoint: YawPose } {
    // Facing ahead (+Z) once the hips are turned by the Seat's yaw; at the hips' own height (the Seat on the floor).
    const yaw = -seated[3]
    const [x, , z] = rotateByYaw(seated[0], seated[1], seated[2], yaw)
    const seat: YawPose = [CAR_FIT.hipsXZ[0] - x, 0, CAR_FIT.hipsXZ[1] - z, yaw]
    return { seat, enterPoint: yawPoseMul(seat, yawPoseInvert(enter)), exitPoint: yawPoseMul(seat, exit) }
}

/** `v` as plain numbers, rounded (for the JSON). */
export const rounded = (v: ArrayLike<number>, f = 1e4) => Array.from(v, x => Math.round(x * f) / f)

