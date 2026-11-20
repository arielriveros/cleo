#!/usr/bin/env node
// Stage 1 of the Sandbox example: the Locomotion Pack's FBX files read once, into caches the generator reads in
// seconds.
//
//     node --max-old-space-size=8192 tools/sandbox/prepare.mjs
//
// Reads build/LocomotionPack (the mannequin and every clip) and the car's clips in build/car (getting in, driving and
// getting out), and writes build/sandbox_prepared/ (gitignored):
//
//   character.json    { skin, parts, height }: the mannequin's skeleton in METRES on unit-scale joints, its mesh
//                     welded, and a `Pivot` joint above the hips (see below)
//   maps/<name>.png   the maps embedded in the FBX, halved to 2048 px
//   clips/<stem>.json one per clip file: retargeted onto that skeleton by NAME, travel KEPT (the generator measures
//                     it before taking it out), plus the hips-ratio the retarget saw
//   stamp.json        what each output was made from (size + time), so a re-run converts only what changed
//
// The pipeline is the shared one (tools/exampleKit/fbxImport.mjs): assimp, the engine's own pivot fold and
// retarget. The character recipe is tools/fps/prepareCharacters.mjs's (that file runs on import, so it is copied).
//
// THE PIVOT JOINT. Root motion moves the character by the WHOLE change of the clip's highest animated joint. A
// Mixamo clip's highest joint is the hips, which bob and tilt with every step, so a turn-in-place clip played
// with root motion would bob and tilt the capsule and freeze the hips. The node above the hips (assimp's
// `RootNode_node`, identity once the skin is in metres) becomes a weightless joint named `Pivot`: the generator
// moves a turn clip's yaw onto it, so the capsule turns and nothing else moves. A clip that never animates it
// (every other clip) still has the hips as its root. (Named Pivot, not Root: `root` is a synonym for the hips in
// the engine's bone-name rules.)

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { mat4 } from 'gl-matrix'
import {
  editorModules, engineModules, importClipFile, loadAssimp, nodeGraphOf, readAccessor, retargetTargetOf, toGltf,
} from '../exampleKit/fbxImport.mjs'
import { normalizeSkin } from '../exampleKit/skinnedGlb.mjs'
import { inflateSync } from 'zlib'
import { decodePng, encodePng } from '../exampleKit/png.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PACK = path.join(ROOT, 'build', 'LocomotionPack')
/** The car's folder: its model (build.ts reads it) and the Mixamo clips of getting in, driving and getting out. */
const CAR = path.join(ROOT, 'build', 'car')
const OUT = path.join(ROOT, 'build', 'sandbox_prepared')
const CHARACTER = path.join(PACK, 'Mannequin.fbx')
/** The file is in centimetres. */
const CM = 0.01
/** The joint added above the hips. */
export const PIVOT_NAME = 'Pivot'
/** Embedded maps are 4096 px; this many halvings bring them to what a sandbox needs. */
const MAP_HALVINGS = 1

const round = (v, f = 1e5) => Math.round(v * f) / f
const stampOf = (file) => { const s = fs.statSync(file); return `${s.size}:${Math.round(s.mtimeMs)}` }

/** Every PNG embedded in the FBX, named by the texture path recorded just before it. */
function embeddedImages(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const iend = Buffer.from('IEND')
  const out = []
  for (let i = buf.indexOf(sig); i >= 0; i = buf.indexOf(sig, i + 8)) {
    const end = buf.indexOf(iend, i)
    if (end < 0) break
    const before = buf.subarray(Math.max(0, i - 600), i).toString('latin1')
    const names = [...before.matchAll(/([A-Za-z0-9_\-]+)\.png/gi)]
    if (!names.length) throw new Error(`an embedded PNG at byte ${i} has no file name before it`)
    out.push({ name: names[names.length - 1][1], bytes: buf.subarray(i, end + 8) })
  }
  return out
}

/**
 * Decode an 8-bit non-interlaced PNG of any colour type but palette to RGBA. The exampleKit decoder takes RGB(A)
 * only, and the mannequin's glossiness map is grey.
 */
function decodeAnyPng(buf) {
  let width = 0, height = 0, channels = 4, colorType = 6
  const idat = []
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    if (type === 'IHDR') {
      width = buf.readUInt32BE(p + 8); height = buf.readUInt32BE(p + 12)
      const depth = buf[p + 16]; colorType = buf[p + 17]
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
      if (depth !== 8 || !channels || buf[p + 20] !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType})`)
    }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len))
    if (type === 'IEND') break
    p += 12 + len
  }
  if (colorType === 2 || colorType === 6) return decodePng(buf)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const line = new Uint8Array(stride), prev = new Uint8Array(stride)
  const data = new Uint8Array(width * height * 4)
  const paeth = (a, b, c) => { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = y > 0 ? prev[x] : 0, c = x >= channels && y > 0 ? prev[x - channels] : 0
      let v = src[x]
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1; else if (filter === 4) v += paeth(a, b, c)
      line[x] = v & 255
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, g = line[x * channels]
      data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = channels === 2 ? line[x * 2 + 1] : 255
    }
    prev.set(line)
  }
  return { width, height, data }
}

/** Halve an RGBA image with a 2x2 box filter. */
function halve(img) {
  const w = img.width >> 1, h = img.height >> 1
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      const s = (dy, dx) => img.data[((y * 2 + dy) * img.width + (x * 2 + dx)) * 4 + c]
      data[(y * w + x) * 4 + c] = (s(0, 0) + s(0, 1) + s(1, 0) + s(1, 1) + 2) >> 2
    }
  }
  return { width: w, height: h, data }
}

/** One part per primitive (material), welded. UVs V-flipped, as GLTFLoader (and readSkinnedGltf) store them. */
function weldedParts(gltf, bin, mesh) {
  return mesh.primitives.map((prim) => {
    const a = prim.attributes
    const p = readAccessor(gltf, bin, a.POSITION), n = readAccessor(gltf, bin, a.NORMAL)
    const t = a.TEXCOORD_0 !== undefined ? readAccessor(gltf, bin, a.TEXCOORD_0) : new Float32Array(p.length / 3 * 2)
    const j = readAccessor(gltf, bin, a.JOINTS_0), w = readAccessor(gltf, bin, a.WEIGHTS_0)
    const idx = prim.indices !== undefined ? readAccessor(gltf, bin, prim.indices) : [...Array(p.length / 3).keys()]
    const part = { material: prim.material ?? 0, positions: [], normals: [], uvs: [], indices: [], jointIndices: [], jointWeights: [] }
    const seen = new Map()
    for (const v of idx) {
      const key = `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]},${n[v * 3]},${n[v * 3 + 1]},${n[v * 3 + 2]},${t[v * 2]},${t[v * 2 + 1]},`
        + `${j[v * 4]},${j[v * 4 + 1]},${j[v * 4 + 2]},${j[v * 4 + 3]},${w[v * 4]},${w[v * 4 + 1]},${w[v * 4 + 2]},${w[v * 4 + 3]}`
      let out = seen.get(key)
      if (out === undefined) {
        out = part.positions.length / 3
        seen.set(key, out)
        part.positions.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2])
        part.normals.push(n[v * 3], n[v * 3 + 1], n[v * 3 + 2])
        part.uvs.push(t[v * 2], 1 - t[v * 2 + 1])
        part.jointIndices.push(j[v * 4], j[v * 4 + 1], j[v * 4 + 2], j[v * 4 + 3])
        part.jointWeights.push(w[v * 4], w[v * 4 + 1], w[v * 4 + 2], w[v * 4 + 3])
      }
      part.indices.push(out)
    }
    return part
  })
}

async function prepareCharacter(ajs) {
  fs.mkdirSync(path.join(OUT, 'maps'), { recursive: true })
  for (const im of embeddedImages(fs.readFileSync(CHARACTER))) {
    let img = decodeAnyPng(Buffer.from(im.bytes))
    for (let i = 0; i < MAP_HALVINGS; i++) img = halve(img)
    fs.writeFileSync(path.join(OUT, 'maps', `${im.name}.png`), encodePng(img.width, img.height, img.data))
    console.log(`map ${im.name}: ${img.width} px`)
  }

  const { gltf, bin } = await toGltf(ajs, CHARACTER)
  const { collapseFbxPivots } = engineModules(ROOT)
  const gskin = gltf.skins[0]
  const ibms = readAccessor(gltf, bin, gskin.inverseBindMatrices)
  const graph = nodeGraphOf(gltf)
  const joints = gskin.joints.map((nodeIndex, i) => ({
    nodeIndex, inverseBindMatrix: mat4.clone(ibms.subarray(i * 16, i * 16 + 16)), parentIndex: graph.nodeParents.get(nodeIndex),
  }))
  const folded = collapseFbxPivots(graph, [], joints)
  if (joints.some(j => folded.removed.has(j.nodeIndex))) throw new Error('a joint is a pivot node')
  const survivor = [...folded.nodeNames.values()].find(n => n.includes('$AssimpFbx$'))
  if (survivor) throw new Error(`a pivot survived the fold: ${survivor}`)

  const skin = {
    name: 'Mannequin',
    joints: joints.map(j => ({ nodeIndex: j.nodeIndex, inverseBindMatrix: Array.from(j.inverseBindMatrix), ...(j.parentIndex !== undefined ? { parentIndex: j.parentIndex } : {}) })),
    nodeParents: [...folded.nodeParents.entries()],
    nodeTransforms: [...folded.nodeTransforms.entries()].map(([i, m]) => [i, Array.from(m)]),
    nodeNames: [...folded.nodeNames.entries()].filter(([, n]) => n),
  }
  const meshNodes = gltf.nodes.filter(n => n.mesh !== undefined && n.skin !== undefined)
  if (meshNodes.length !== 1) throw new Error(`expected one skinned mesh, found ${meshNodes.length}`)
  const parts = weldedParts(gltf, bin, gltf.meshes[meshNodes[0].mesh])
  normalizeSkin(skin, parts, CM)

  // The Pivot: the hips' parent, made a joint (appended, so no vertex's joint index moves).
  const names = new Map(skin.nodeNames)
  const hips = [...names].find(([, n]) => /:Hips$/.test(n))?.[0]
  if (hips === undefined) throw new Error('no Hips bone')
  const pivot = new Map(skin.nodeParents).get(hips)
  if (pivot === undefined) throw new Error('the hips have no parent node to make the pivot')
  const pivotLocal = new Map(skin.nodeTransforms).get(pivot)
  if (pivotLocal.some((v, i) => Math.abs(v - mat4.create()[i]) > 1e-6)) throw new Error('the pivot node is not at identity')
  skin.nodeNames = skin.nodeNames.map(([i, n]) => [i, i === pivot ? PIVOT_NAME : n])
  if (!skin.nodeNames.some(([i]) => i === pivot)) skin.nodeNames.push([pivot, PIVOT_NAME])
  // Its parent is outside the skin; the hips' parentIndex is a node index too, which already names it.
  skin.joints.push({ nodeIndex: pivot, inverseBindMatrix: Array.from(mat4.create()) })

  let top = -Infinity, bottom = Infinity
  for (const p of parts) for (let k = 1; k < p.positions.length; k += 3) { top = Math.max(top, p.positions[k]); bottom = Math.min(bottom, p.positions[k]) }
  const out = { skin, parts, height: top - bottom, hipsNode: hips, pivotNode: pivot }
  fs.writeFileSync(path.join(OUT, 'character.json'), JSON.stringify(out))
  const verts = parts.reduce((s, p) => s + p.positions.length / 3, 0), tris = parts.reduce((s, p) => s + p.indices.length / 3, 0)
  console.log(`character: ${skin.joints.length} joints (incl. Pivot), ${folded.removed.size} pivots folded, ${verts} vertices, ${tris} triangles, ${out.height.toFixed(3)} m tall`)
  return out
}

/** A retargeted clip as plain JSON: typed arrays to arrays, rounded. */
function plainClip(clip) {
  return {
    name: clip.name,
    samplers: clip.samplers.map(s => ({ input: Array.from(s.input, v => round(v)), output: Array.from(s.output, v => round(v)), interpolation: s.interpolation ?? 'LINEAR' })),
    channels: clip.channels.map(c => ({ samplerIndex: c.samplerIndex, targetNodeIndex: c.targetNodeIndex, targetPath: c.targetPath })),
  }
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'clips'), { recursive: true })
  const stampFile = path.join(OUT, 'stamp.json')
  const stamps = fs.existsSync(stampFile) ? JSON.parse(fs.readFileSync(stampFile, 'utf8')) : {}
  const ajs = await loadAssimp(ROOT)

  const characterFile = path.join(OUT, 'character.json')
  let character
  if (stamps['Mannequin.fbx'] === stampOf(CHARACTER) && fs.existsSync(characterFile)) {
    character = JSON.parse(fs.readFileSync(characterFile, 'utf8'))
    console.log('character: unchanged')
  } else {
    character = await prepareCharacter(ajs)
    stamps['Mannequin.fbx'] = stampOf(CHARACTER)
    // A new skeleton invalidates every clip retargeted onto the old one.
    for (const k of Object.keys(stamps)) if (k !== 'Mannequin.fbx') delete stamps[k]
  }

  const { storeSkin, loadSkin } = editorModules(ROOT)
  const target = retargetTargetOf(loadSkin, storeSkin(character.skin))
  const { collapseFbxPivots, buildBoneMapping, retargetAnimation } = engineModules(ROOT)
  const ctx = { ajs, collapseFbxPivots, buildBoneMapping, retargetAnimation }

  // Every clip file: the pack's, then the car's (a stem names its clip whichever folder it is in).
  const fbx = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.fbx$/i.test(f) && f !== 'Mannequin.fbx').sort().map(f => [dir, f]) : []
  const sources = [...fbx(PACK), ...fbx(CAR)]
  const files = sources.map(([, f]) => f)
  for (const [dir, f] of sources) {
    const stem = f.replace(/\.fbx$/i, '')
    const outFile = path.join(OUT, 'clips', `${stem}.json`)
    const file = path.join(dir, f)
    if (stamps[f] === stampOf(file) && fs.existsSync(outFile)) continue
    // The pack's clips were downloaded on two Mixamo characters: this one (ratio ~1) and one ~6% smaller.
    // The retarget rescales the hips by the ratio, which in-place clips want; the file is in cm, the skin in m.
    const r = await importClipFile(ctx, file, stem, target, { rootMotion: true, ratioRange: [0.8 * CM, 1.2 * CM] })
    delete r.clip.rootMotion
    fs.writeFileSync(outFile, JSON.stringify({ clip: plainClip(r.clip), seconds: r.seconds, ratio: r.ratio / CM }))
    stamps[f] = stampOf(file)
    console.log(`clip ${stem}: ${r.seconds.toFixed(3)} s, hips ratio ${(r.ratio / CM).toFixed(3)}`)
  }
  // Clips whose file is gone.
  for (const f of fs.readdirSync(path.join(OUT, 'clips'))) {
    if (!files.some(x => x.replace(/\.fbx$/i, '') + '.json' === f)) fs.rmSync(path.join(OUT, 'clips', f))
  }
  fs.writeFileSync(stampFile, JSON.stringify(stamps, null, 1))
  console.log(`prepared ${files.length} clips into ${path.relative(ROOT, OUT)}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
