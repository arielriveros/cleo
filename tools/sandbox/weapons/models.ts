// The Sandbox's two weapons: "Low-Poly G40" (build/low-poly_g40.glb, a pistol) and "Low-Poly M4a1"
// (build/low-poly_m4a1.glb, a rifle), both by TastyTony (https://sketchfab.com/TastyTony), CC-BY-4.0, via Sketchfab.
// Pure data, like car.ts: build.ts turns them into model assets, and poses.ts holds them in the mannequin's hands.
//
// Both files are skinned (a slide, a magazine and a bolt on bones of their own) and never animate: they are read at
// their rest pose and baked into plain meshes. Each file has its bore along +X and its top along +Y (its right side
// on +Z). They come out in WEAPON SPACE, the frame the hands and sockets are worked out in:
//
//   origin  the GRIP: the middle of the pistol grip, where the right hand closes (see `gripOf`)
//   +Z      along the bore, toward the muzzle
//   +Y      up (the sights' side; the magazine hangs below)
//   +X      the weapon's left (a right-handed frame: a weapon held pointing ahead has the character's own axes)
//
// in metres, scaled so the weapon is as long as the real one (`SPECS`). With them, the points poses.ts holds them by:
// the support hand's place (a rifle's handguard), the muzzle, the butt (a rifle's stock, against the shoulder), and
// the sight line (what the eye looks along when aiming).

import { mat4, vec3 } from 'gl-matrix'
import { readGltf } from '../../valley/meshes.mjs'
import { readSkinnedGltf, restWorld } from '../../exampleKit/skinnedGlb.mjs'

export type WeaponKind = 'pistol' | 'rifle'

export interface WeaponPart {
    material: number
    positions: Float32Array
    normals: Float32Array
    uvs: Float32Array
    indices: Uint32Array
}

export interface WeaponMaterial { name: string; color: [number, number, number]; metallic: number; roughness: number }

export interface WeaponModel {
    kind: WeaponKind
    /** The model asset's name (and every instance's: the editor renames a placed model to its asset's). */
    name: 'Pistol' | 'Rifle'
    file: string
    /** One part per material, in weapon space. */
    parts: WeaponPart[]
    materials: WeaponMaterial[]
    /** The bounds, weapon space. */
    min: vec3
    max: vec3
    /** The grip's axis, up from the bottom of the grip toward the top (unit, weapon space): what the right hand's fist closes round. */
    gripAxis: vec3
    /** Where the support hand closes: a rifle's handguard, on its axis; a pistol's, the grip itself (the hand wraps the other). */
    support: vec3
    /** The muzzle, on the bore's axis. */
    muzzle: vec3
    /** A rifle's butt: the middle of its stock's end (the shoulder pocket's). A pistol's back end. */
    butt: vec3
    /** The sight line's height over the bore, and a point on it over the grip: the eye looks along it when aiming. */
    sight: vec3
    /** The bore's height over the grip, m. */
    boreHeight: number
}

/** What is known of each file beyond its geometry: its real length, and where its grip is, in the file's units. */
const SPECS: Record<WeaponKind, {
    file: string; name: 'Pistol' | 'Rifle'
    /** Overall length, m: the Glock 40's 241 mm (the long slide the model has), an M4A1's 838 mm with its stock out. */
    length: number
    /**
     * The pistol grip, in the file's units (x along the bore, y up), read off a side render of each file: a band of it
     * below the trigger guard (`x` wide enough to hold the whole grip there), whose slices' middles give its axis, and
     * the height on that axis the right hand's fist closes round (the middle of its four fingers, under the slide or
     * the receiver).
     */
    gripBox: { x: [number, number]; y: [number, number] }
    fistY: number
    /** How far forward of the grip the support hand closes, m (the rifle pack's two hands are 0.24 m apart); 0 for the pistol. */
    supportAhead: number
    /** The bone the magazine hangs from: it says which way is down. */
    magazine: string
}> = {
    pistol: { file: 'low-poly_g40.glb', name: 'Pistol', length: 0.241, gripBox: { x: [-3.9, -0.8], y: [-3.2, -1.4] }, fistY: -1.9, supportAhead: 0, magazine: 'mag_3' },
    rifle: { file: 'low-poly_m4a1.glb', name: 'Rifle', length: 0.838, gripBox: { x: [-46, -18], y: [-19, -7] }, fistY: -10, supportAhead: 0.24, magazine: 'mag_06' },
}

/** The file's rest pose as plain triangles, in the file's units (scene space), one part per material. */
function bakedParts(doc: any): { parts: (WeaponPart & { name: string })[]; jointAt: (name: string) => vec3 } {
    const { skin, parts } = readSkinnedGltf(doc)
    const toJoint = skin.joints.map((j: any) => mat4.multiply(mat4.create(), restWorld(skin, j.nodeIndex), Float32Array.from(j.inverseBindMatrix) as unknown as mat4))
    const names = new Map<number, string>(skin.nodeNames)
    const out = parts.map((p: any) => {
        const n = p.positions.length / 3
        const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3)
        const v = vec3.create(), q = vec3.create(), nrm = vec3.create(), r = vec3.create()
        for (let i = 0; i < n; i++) {
            vec3.set(v, 0, 0, 0); vec3.set(nrm, 0, 0, 0)
            for (let k = 0; k < 4; k++) {
                const w = p.jointWeights[i * 4 + k]
                if (!w) continue
                const m = toJoint[p.jointIndices[i * 4 + k]]
                vec3.transformMat4(q, [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]], m)
                vec3.scaleAndAdd(v, v, q, w)
                // Rigid bones (no scale): the rotation part carries the normal.
                vec3.set(r, p.normals[i * 3], p.normals[i * 3 + 1], p.normals[i * 3 + 2])
                vec3.transformMat4(r, r, m)
                vec3.sub(r, r, mat4.getTranslation(q, m))
                vec3.scaleAndAdd(nrm, nrm, r, w)
            }
            positions.set(v, i * 3)
            normals.set(vec3.normalize(nrm, nrm), i * 3)
        }
        return { name: '', material: p.material, positions, normals, uvs: Float32Array.from(p.uvs), indices: Uint32Array.from(p.indices) }
    })
    const jointAt = (name: string) => {
        for (const [i, n] of names) if (n === name) return mat4.getTranslation(vec3.create(), restWorld(skin, i))
        throw new Error(`no joint ${name}`)
    }
    return { parts: out, jointAt }
}

const ROOT_BUILD = (root: string) => `${root}/build`

/** Read one weapon into weapon space. `root` is the repository's root. */
export function readWeapon(root: string, kind: WeaponKind): WeaponModel {
    const spec = SPECS[kind]
    const file = `${ROOT_BUILD(root)}/${spec.file}`
    const doc = readGltf(file) as { gltf: any; bin: Buffer }
    const { parts, jointAt } = bakedParts(doc)

    // The file's bounds, and its grip: the vertices in the grip's box (file units, x along the bore, y up).
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p.positions[i + a]); hi[a] = Math.max(hi[a], p.positions[i + a])
    }
    const length = hi[0] - lo[0]
    const scale = spec.length / length
    if (jointAt(spec.magazine)[1] > (lo[1] + hi[1]) / 2) throw new Error(`${spec.file}: its magazine is above its middle; the file is upside down?`)

    // File units -> weapon space: x_w = -z_f (the file's +Z is the weapon's right), y_w = y_f, z_w = x_f; scaled.
    const toWeapon = (x: number, y: number, z: number, out = vec3.create()) => vec3.set(out, -z * scale, y * scale, x * scale)
    const inBox = (x: number, y: number) => x >= spec.gripBox.x[0] && x <= spec.gripBox.x[1] && y >= spec.gripBox.y[0] && y <= spec.gripBox.y[1]
    // The grip's axis: the middle of the grip, front to back, at each height of the band, fitted with a line (it
    // leans: the bottom of a grip is behind its top). In the file's units, x along the bore.
    // A low-poly grip has few vertices, so each height is cut through its triangles: where their edges cross it.
    const slices = 8
    const mids: [number, number][] = []
    for (let k = 0; k < slices; k++) {
        const yc = spec.gripBox.y[0] + (spec.gripBox.y[1] - spec.gripBox.y[0]) * (k + 0.5) / slices
        let back = Infinity, front = -Infinity
        for (const p of parts) for (let t = 0; t < p.indices.length; t += 3) for (let e = 0; e < 3; e++) {
            const a = p.indices[t + e] * 3, b = p.indices[t + (e + 1) % 3] * 3
            const ya = p.positions[a + 1], yb = p.positions[b + 1]
            if ((ya - yc) * (yb - yc) > 0 || ya === yb) continue
            const x = p.positions[a] + (p.positions[b] - p.positions[a]) * (yc - ya) / (yb - ya)
            if (!inBox(x, yc)) continue
            back = Math.min(back, x); front = Math.max(front, x)
        }
        if (front > back) mids.push([(back + front) / 2, yc])
    }
    if (mids.length < 3) throw new Error(`${spec.file}: the grip's band holds too little of it`)
    const my = mids.reduce((s, m) => s + m[1], 0) / mids.length, mx = mids.reduce((s, m) => s + m[0], 0) / mids.length
    const slope = mids.reduce((s, m) => s + (m[0] - mx) * (m[1] - my), 0) / mids.reduce((s, m) => s + (m[1] - my) ** 2, 0)   // dx / dy
    const axis = vec3.normalize(vec3.create(), toWeapon(slope, 1, 0))
    const origin = toWeapon(mx + slope * (spec.fistY - my), spec.fistY, 0)

    // Everything in weapon space, the grip at the origin.
    const out: WeaponPart[] = parts.map(p => {
        const positions = new Float32Array(p.positions.length), normals = new Float32Array(p.normals.length)
        const v = vec3.create()
        for (let i = 0; i < p.positions.length; i += 3) {
            toWeapon(p.positions[i], p.positions[i + 1], p.positions[i + 2], v)
            vec3.sub(v, v, origin)
            positions.set(v, i)
            normals.set([-p.normals[i + 2], p.normals[i + 1], p.normals[i]], i)
        }
        return { material: p.material, positions, normals, uvs: p.uvs, indices: p.indices }
    })
    const min = vec3.fromValues(Infinity, Infinity, Infinity), max = vec3.fromValues(-Infinity, -Infinity, -Infinity)
    for (const p of out) for (let i = 0; i < p.positions.length; i += 3) for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p.positions[i + a]); max[a] = Math.max(max[a], p.positions[i + a])
    }
    /** The middle of the weapon's y extent among the vertices within `band` of `z` (and above `floor`, if given). */
    const axisAt = (z: number, band: number, floor = -Infinity) => {
        let lo = Infinity, hi = -Infinity
        for (const p of out) for (let i = 0; i < p.positions.length; i += 3) {
            if (Math.abs(p.positions[i + 2] - z) > band || p.positions[i + 1] < floor) continue
            lo = Math.min(lo, p.positions[i + 1]); hi = Math.max(hi, p.positions[i + 1])
        }
        return { mid: (lo + hi) / 2, lo, hi }
    }
    const muzzleAxis = axisAt(max[2] - 0.004, 0.006)
    const muzzle = vec3.fromValues(0, muzzleAxis.mid, max[2])
    const buttAxis = axisAt(min[2] + 0.006, 0.008)
    const butt = vec3.fromValues(0, buttAxis.mid, min[2])
    // A rifle's support hand closes round the handguard, on its axis (the bore's height there); a pistol's wraps the
    // grip hand, round the grip itself.
    const support = spec.supportAhead > 0
        ? vec3.fromValues(0, (() => { const a = axisAt(spec.supportAhead, 0.02, 0); return a.mid })(), spec.supportAhead)
        : vec3.fromValues(0, 0, 0)
    // The sights: the top of the weapon over the grip (the rifle's optic, the pistol's slide), less a centimetre.
    const sightTop = axisAt(kind === 'rifle' ? 0.05 : 0, kind === 'rifle' ? 0.06 : 0.03).hi
    const sight = vec3.fromValues(0, sightTop - 0.01, 0)

    const materials: WeaponMaterial[] = doc.gltf.materials.map((m: any) => {
        const p = m.pbrMetallicRoughness ?? {}
        const c = p.baseColorFactor ?? [0.5, 0.5, 0.5, 1]
        return { name: m.name, color: [c[0], c[1], c[2]], metallic: p.metallicFactor ?? 0, roughness: p.roughnessFactor ?? 0.9 }
    })
    return {
        kind, name: spec.name, file: spec.file, parts: out, materials, min, max,
        gripAxis: axis, support, muzzle, butt, sight, boreHeight: muzzle[1],
    }
}

/** `v` rounded to millimetres, for reports. */
export const mm = (v: ArrayLike<number>) => Array.from(v, x => Math.round(x * 1000) / 10).join(', ') + ' cm'
