// The Sandbox car: build/car/dirty_car.glb ("Dirty car" by 3D Error 404, CC-BY-4.0, via Sketchfab), read and cut
// into what the Car template is made of. Pure data, like level.ts: build.ts turns it into model assets and nodes.
//
// The file is in centimetres, its front +Z, its left +X, its origin on the ground under the middle of the body. It is
// mirrored across its centre line on the way in: the model is right-hand drive (its steering wheel on the right),
// and the Mixamo clips get in on the driver's LEFT. It is kept at its own size (6 m long, 1.79 m tall): the clips'
// seated pose fits its cabin (scaled to a sedan's 4.7 m, the head goes through the roof).
//
//   body, glass  the body (opaque) and the windows (blended): one node each under one Body node (the renderer picks a
//                pass per node, so the two cannot share one mesh)
//   wheels       one mesh holding all four: cut apart by which corner each triangle is at, each centred on its hub
//                (a Wheel node turns its own tyre, so each is its own node); the front left one is the Car Wheel model
//   chassis      two boxes for the Collider: the lower body, and the cabin above the beltline

import { mat4 } from 'gl-matrix'
import { readGltf, partsOf, boundsOf } from '../valley/meshes.mjs'
import { localMatrix } from '../exampleKit/fbxImport.mjs'
import { rotateByYaw, yawPoseInvert, yawPoseMul, type YawPose } from '../../src/core/math'

/** Centimetres to metres. */
export const CAR_SCALE = 0.01

/**
 * Where the driver's hips sit, seated, in the (mirrored) car's frame, x and z: over the cushion of the driver's seat,
 * far enough forward that the hands of the seated clips meet the steering wheel's grip (its centre at x 0.489,
 * z 0.715). Measured on the model; the height is the clips' own (getting in ends with the hips that high).
 */
const SEATED_HIPS_XZ: [number, number] = [0.48, 0.26]

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

export interface CarBox {
    size: [number, number, number]
    centre: [number, number, number]
}

export interface CarModel {
    body: CarPart
    glass: CarPart
    /** The front left wheel, centred on its hub, its axle along X, its hub facing +X (outward on the left). */
    wheel: CarPart
    wheels: CarWheel[]
    /** The lower body, and the cabin over it: the chassis Collider's two boxes. */
    chassis: [CarBox, CarBox]
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
            canonical = { ...part, name: 'Tyre' }
        }
    }

    // The chassis: the lower body (its length and its width below the mirrors, from the sill up to the beltline) and the
    // cabin (what is above the beltline: the glasshouse and the roof).
    const bb = boundsOf([body])
    const p = body.positions
    const BELT = 1.15
    let halfWidth = 0, cabinMin = [Infinity, Infinity], cabinMax = [-Infinity, -Infinity], top = 0
    for (let k = 0; k < p.length; k += 3) {
        const x = p[k], y = p[k + 1], z = p[k + 2]
        if (y > 0.45 && y < 0.95) halfWidth = Math.max(halfWidth, Math.abs(x))
        // Its width over the mirrors (they stand out at the beltline), its length and height from all of it.
        if (y > BELT + 0.25) { cabinMin[0] = Math.min(cabinMin[0], x); cabinMax[0] = Math.max(cabinMax[0], x) }
        if (y > BELT + 0.1) {
            cabinMin[1] = Math.min(cabinMin[1], z); cabinMax[1] = Math.max(cabinMax[1], z)
            top = Math.max(top, y)
        }
    }
    const bottom = bb.min[1]
    const lower: CarBox = { size: [2 * halfWidth, BELT - bottom, bb.size[2]], centre: [0, (BELT + bottom) / 2, (bb.min[2] + bb.max[2]) / 2] }
    const cabinHalf = Math.max(Math.abs(cabinMin[0]), Math.abs(cabinMax[0]))
    const cabin: CarBox = {
        size: [2 * cabinHalf, top - BELT, cabinMax[1] - cabinMin[1]],
        centre: [0, (top + BELT) / 2, (cabinMin[1] + cabinMax[1]) / 2],
    }

    const images = (gltf.images ?? []).map((img: any) => {
        const view = gltf.bufferViews[img.bufferView]
        const start = view.byteOffset ?? 0
        return { bytes: Buffer.from(bin.subarray(start, start + view.byteLength)), mime: img.mimeType ?? 'image/png' }
    })
    const textures = (gltf.textures ?? []).map((t: any) => t.source)
    return {
        body, glass, wheel: canonical!, wheels, chassis: [lower, cabin],
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
    const seat: YawPose = [SEATED_HIPS_XZ[0] - x, 0, SEATED_HIPS_XZ[1] - z, yaw]
    return { seat, enterPoint: yawPoseMul(seat, yawPoseInvert(enter)), exitPoint: yawPoseMul(seat, exit) }
}

/** `v` as plain numbers, rounded (for the JSON). */
export const rounded = (v: ArrayLike<number>, f = 1e4) => Array.from(v, x => Math.round(x * f) / f)

