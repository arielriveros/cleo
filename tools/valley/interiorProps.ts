// Furniture for the hamlet's two enterable houses, the Long House and the Old House, applied to the SHIPPED
// Valley (build.mjs cannot run any more; see bundleOps.ts).
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyInteriorProps.ts [--reimport] [--dry]
//
// The pieces come from build/additional_valley_props (gitignored): six Poly Haven glTF zips in real-world
// metres (a dining table, a low table, a wall shelf, a worn bookshelf, a painted cabinet and a tall one) and
// four Sketchfab GLBs, all CC-BY-4.0: "Old Bed" by donnichols, "Asset04 Medieval Bellows" by Margot D.
// (Winterll, in centimetres), "Medieval Grindstone" by Thangzy and "Rug" by _dark_alice_. Each becomes ONE library
// model with one material, its maps as textures, under /Props/Furniture, through the part pipeline the
// Valley's other meshes went through (meshes.mjs: uv v flipped, no tangents, numbers rounded). Every map
// ships as a JPEG at most 1k a side: a Poly Haven map as it comes where it is quality 90 or so already, the
// quality-100 ones and the GLBs' PNG maps (2k for the bed) re-encoded at quality 90 by Pillow
// (`python -I`), the one step that needs Python.
//
// A model already in the library is reused as it is unless `reimport` is asked for, so a re-run (from
// applyCinematic.ts, say) needs neither the sources nor Python, and changes nothing; a piece new to PIECES
// is imported on its own, the others left as they are.
//
// The scene gets `Furniture` beside `Buildings`: one group per house standing exactly where the house does
// (its lodGroup's position and turn, scale 1), the pieces inside it in the HOUSE'S OWN FRAME, as linked
// copies of the library models (`__modelId`), each with a draw distance (Node.drawDistance) so it culls
// from afar. LAYOUT gives each piece a nominal spot and turn and names the walls it backs onto; those walls
// are found in the house's render mesh (level 0) by casting rays out of the piece, and the boards under it
// the same way, so it stands on the floor a couple of centimetres off its walls however they bow.
//
// Not here: light_pole.glb and well.glb stand outdoors, along the trail and on the square (hamletDressing.ts).
//
// CANDLES stand on the tables and cabinets (`Candles`, beside `Furniture`, one group per house in its frame):
// a procedural candle (dungeon/props.mjs) as one more library model, the Torch Fire flame of the wall torches
// shrunk to a candle's, and a 60 lm light that casts no shadow, all under the Fire Light script as every fire
// in the Valley is. They burn round the clock: by day the sun drowns them; at night the GI carries them round
// the room and the interior's auto exposure opens up to them.
//
// GI: every piece stands inside Hamlet GI and its house's Interior GI volume, whose bake signature keys the
// static geometry it can see by transform, material type and size (giSystem.ts `_signature`). Furnishing
// therefore makes those three shipped bakes stale: the editor captures them again on load until
// `node tools/valley/bakeGI.cjs` bakes them afresh.

import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { spawnSync } from 'child_process'
import { readGltf, partsOf, mergeByMaterial, normalizeParts, boundsOf } from './meshes.mjs'
import { buildCandle } from './dungeon/props.mjs'
import { ROOT, VALLEY_SCENE, id, log, child, nodes, attach } from './bundleOps'

export const SOURCE_DIR = path.join(ROOT, 'build', 'additional_valley_props')
const FOLDER = '/Props/Furniture'

/** Past this distance from the camera (to its origin) a piece is not drawn: the buildings' first LOD step. */
export const FURNITURE_DRAW_DISTANCE = 40
/** How far a piece stands off a wall it backs onto. */
const WALL_GAP = 0.02
/** The largest side a texture ships at, and the JPEG quality a re-encoded one is written with. */
const TEXTURE_SIZE = 1024
const JPEG_QUALITY = 90

/** The Valley's texture record, as build.mjs `tex` wrote every one of its maps. */
export const TEXTURE_CONFIG = { flipY: false, usage: 'color', wrapping: 'repeat', mipMap: true, mipMapFilter: 'linear', precision: 'low', target: 'texture2D' }

// ---------------------------------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------------------------------

interface PieceSpec {
  key: string
  /** The library model's (and its material's) name. */
  name: string
  file: string
  /** Uniform scale into metres, before the base centre goes to the origin. */
  scale?: number
}

/**
 * Every asset's frame (the dungeon props' convention): the middle of its footprint on the floor at the
 * origin, +Y up, its FRONT toward +Z, so a piece backing onto a wall turns +Z away from it. The bed's head
 * is at -Z, the bellows' nozzle at -X.
 */
export const PIECES: PieceSpec[] = [
  // 1.76 m long and 0.79 wide as it comes: a child's bed beside the 2 m houses' doorways. A tenth more
  // makes it 1.93 x 0.87.
  { key: 'bed', name: 'Old Bed', file: 'old_bed.glb', scale: 1.1 },
  { key: 'dining-table', name: 'Dining Table', file: 'dining_table_1k.gltf.zip' },
  { key: 'low-table', name: 'Low Table', file: 'WoodenTable_01_1k.gltf.zip' },
  { key: 'wall-shelf', name: 'Wall Shelf', file: 'Shelf_01_1k.gltf.zip' },
  { key: 'bookshelf', name: 'Worn Bookshelf', file: 'wooden_bookshelf_worn_1k.gltf.zip' },
  { key: 'cabinet', name: 'Painted Cabinet', file: 'painted_wooden_cabinet_1k.gltf.zip' },
  { key: 'tall-cabinet', name: 'Tall Painted Cabinet', file: 'painted_wooden_cabinet_02_1k.gltf.zip' },
  // Centimetres: 1.9 m of frame and lever, the pivot 1.4 m up.
  { key: 'bellows', name: 'Forge Bellows', file: 'asset04_medieval_bellows.glb', scale: 0.01 },
  // Already metres: a 0.67 m wheel on a 2 m trestle, its axle at 0.87 m.
  { key: 'grindstone', name: 'Grindstone', file: 'medieval_grindstone.glb' },
  // Metres: a 3.0 x 1.9 m woven rug, a few centimetres thick at its rolled hem.
  { key: 'rug', name: 'Rug', file: 'rug.glb' },
]

export const modelIdOf = (key: string) => id(`furniture:model:${key}`)
const materialIdOf = (key: string) => id(`furniture:material:${key}`)
const textureIdOf = (key: string, slot: string) => id(`furniture:texture:${key}:${slot}`)

// ---------------------------------------------------------------------------------------------------
// Where they go
// ---------------------------------------------------------------------------------------------------

type Wall = '+x' | '-x' | '+z' | '-z'
interface Placement {
  /** The scene node's name. */
  name: string
  piece: string
  /** Nominal spot in the house's frame (metres, x and z); the walls in `against` then move it onto them. */
  at: [number, number]
  /** Turn about +Y in the house's frame, degrees (a multiple of 90): 0 faces +Z, 90 +X, 180 -Z, -90 -X. */
  yaw: number
  against?: Wall[]
}
export interface HouseLayout {
  /** The building (a lodGroup under Buildings) whose frame the pieces are in. */
  house: string
  group: string
  pieces: Placement[]
}

/**
 * The two houses, in each one's own frame (the lodGroup's; level 0's triangles are in it).
 *
 * LONG HOUSE: floor 0.40, ceiling 4.27; walls -X at -3.07, +X bowing 3.25..3.81; end walls -Z at about
 * -9.4 (canted) and +Z at 8.33, its door x -0.69..0.86. Two cross walls (z -3.13..-2.97 and 2.97..3.13)
 * reach in from the +X wall to x -0.1, leaving the AISLE x -3.07..-0.25 through all three rooms, which the
 * cinematic dollies down (x -1.65, 1.9 up, z -6.5..2.2) to the middle room's +X door (z -0.8..0.8), where
 * the afternoon sun lays a patch on the boards (x 0.2..3.2, z -1.6..1.6). Nothing stands in the aisle, the
 * patch or a doorway: only the rug lies in the patch, flat before that door, so the sun lands on its colours
 * and the GI bounces them round the room. The door's posts stand at x 3.61 (z +-0.8), the wall beside them
 * at 3.9; the boards run on under the doorway. Four sleeper boards stand 7 cm proud of the floor across the house (z -4.78..-4.16,
 * -2.29..-1.69, 1.69..2.29, 4.16..4.78); no piece stands on one. The +X windows (z -7.8..-6.8, -2.8..-1.6,
 * 1.4..2.6, 6.4..7.4) start a metre up: only the bed, lower than that, sits under one.
 *   - the -Z room, where the dolly sets off: the bedroom. The bed along the +X wall; the tall cabinet and
 *     the painted cabinet backing onto the cross wall, in view down the aisle.
 *   - the middle room: the worn bookshelf on its -Z cross wall, in view as the dolly turns to the sunlit
 *     door; the low table on the +Z one; the rug along the door, its edge 6 cm inside the posts, clear of
 *     the sleepers either side (|z| 1.69 on).
 *   - the +Z room, past the dolly's end: the kitchen. The dining table in the middle, the wall shelf on
 *     the +X wall, the tall cabinet beside the end door.
 *
 * OLD HOUSE: one hall, floor 0.42, walls x -4.14 and 4.48, z -8.23 and 7.40 over a sill beam round the
 * floor (7 cm high, 6-8 cm proud), its door in the +Z wall (x -0.6..0.8); windows high (1.6 m up) on both
 * long walls at z -6.2..-5.0 and 4.2..5.4. Its frame's posts stand 6-9 cm proud of the walls: on the long
 * walls every 1.7 m (at z -6.5, -4.8, -3.0, -1.3, 0.5, 2.2, 4.0, 5.7), on the -Z wall at x -2.45, -0.75,
 * 1.0 and 2.75. The cabinets, the bookshelf and the wall shelf fit between two; the beds and the workshop
 * pieces are longer than a bay and rest against one.
 *   - the -Z end sleeps: a bed in each corner, the tall cabinet and the painted cabinet between them.
 *   - the -X wall: the bookshelf, the wall shelf. The dining table down the middle.
 *   - the +X wall by the door is the workshop: the bellows in the corner (nozzle to the corner), the
 *     grindstone, the low table as its bench.
 */
export const LAYOUT: HouseLayout[] = [
  {
    house: 'Long House', group: 'Long House Furniture', pieces: [
      { name: 'Bed', piece: 'bed', at: [2.8, -5.98], yaw: 0, against: ['+x'] },
      { name: 'Tall Cabinet', piece: 'tall-cabinet', at: [0.55, -3.5], yaw: 180, against: ['+z'] },
      { name: 'Painted Cabinet', piece: 'cabinet', at: [2.6, -3.45], yaw: 180, against: ['+z', '+x'] },
      { name: 'Bookshelf', piece: 'bookshelf', at: [1.5, -2.65], yaw: 0, against: ['-z'] },
      { name: 'Low Table', piece: 'low-table', at: [1.5, 2.62], yaw: 0, against: ['+z'] },
      { name: 'Rug', piece: 'rug', at: [2.585, 0], yaw: 90 },
      { name: 'Dining Table', piece: 'dining-table', at: [1.55, 6.0], yaw: 0 },
      { name: 'Wall Shelf', piece: 'wall-shelf', at: [3.2, 3.75], yaw: -90, against: ['+x'] },
      { name: 'Kitchen Cabinet', piece: 'tall-cabinet', at: [2.3, 7.9], yaw: 180, against: ['+z'] },
    ],
  },
  {
    house: 'Old House', group: 'Old House Furniture', pieces: [
      { name: 'Bed 1', piece: 'bed', at: [-3.6, -7.2], yaw: 0, against: ['-x', '-z'] },
      { name: 'Tall Cabinet', piece: 'tall-cabinet', at: [-1.6, -7.8], yaw: 0, against: ['-z'] },
      { name: 'Painted Cabinet', piece: 'cabinet', at: [1.85, -7.8], yaw: 0, against: ['-z'] },
      { name: 'Bed 2', piece: 'bed', at: [3.9, -7.2], yaw: 0, against: ['+x', '-z'] },
      { name: 'Bookshelf', piece: 'bookshelf', at: [-3.7, -3.9], yaw: 90, against: ['-x'] },
      { name: 'Wall Shelf', piece: 'wall-shelf', at: [-3.9, 3.1], yaw: 90, against: ['-x'] },
      { name: 'Dining Table', piece: 'dining-table', at: [0.17, -2.0], yaw: 90 },
      { name: 'Bellows', piece: 'bellows', at: [3.8, 6.3], yaw: 90, against: ['+x', '+z'] },
      { name: 'Grindstone', piece: 'grindstone', at: [4.0, 4.1], yaw: 90, against: ['+x'] },
      { name: 'Workbench', piece: 'low-table', at: [4.1, 1.9], yaw: 90, against: ['+x'] },
    ],
  },
]

// ---------------------------------------------------------------------------------------------------
// Reading the sources
// ---------------------------------------------------------------------------------------------------

/** A fresh, 0-offset copy (typed-array views over it need their alignment). */
const own = (b: Uint8Array) => { const out = Buffer.alloc(b.byteLength); out.set(b); return out }

/** Every entry of a zip, by name. Stored and deflated entries only: what the Poly Haven zips hold. */
function readZip(file: string): Map<string, Buffer> {
  const data = fs.readFileSync(file)
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error(`${path.basename(file)}: not a zip`)
  const out = new Map<string, Buffer>()
  let p = data.readUInt32LE(end + 16)
  for (let n = data.readUInt16LE(end + 10); n > 0; n--) {
    if (data.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path.basename(file)}: bad central directory`)
    const method = data.readUInt16LE(p + 10), size = data.readUInt32LE(p + 20)
    const nameLength = data.readUInt16LE(p + 28), extra = data.readUInt16LE(p + 30), comment = data.readUInt16LE(p + 32)
    const local = data.readUInt32LE(p + 42)
    const name = data.toString('utf8', p + 46, p + 46 + nameLength)
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const raw = data.subarray(start, start + size)
    if (method === 0) out.set(name, own(raw))
    else if (method === 8) out.set(name, own(zlib.inflateRawSync(raw)))
    else throw new Error(`${path.basename(file)}: ${name} uses compression method ${method}`)
    p += 46 + nameLength + extra + comment
  }
  return out
}

export interface Source { gltf: any, bin: Buffer, image: (index: number) => { bytes: Buffer, mime: string } }

/** A .glb, or a zipped .gltf with its .bin and textures beside it. */
export function readSource(file: string): Source {
  if (file.endsWith('.zip')) {
    const entries = readZip(file)
    const gltfName = [...entries.keys()].find(n => n.endsWith('.gltf'))
    if (!gltfName) throw new Error(`${path.basename(file)}: no .gltf inside`)
    const dir = path.posix.dirname(gltfName)
    const at = (uri: string) => {
      const name = dir === '.' ? decodeURIComponent(uri) : `${dir}/${decodeURIComponent(uri)}`
      const bytes = entries.get(name)
      if (!bytes) throw new Error(`${path.basename(file)}: ${name} is missing`)
      return bytes
    }
    const gltf = JSON.parse(entries.get(gltfName)!.toString('utf8'))
    return {
      gltf, bin: at(gltf.buffers[0].uri),
      image: (i) => {
        const im = gltf.images[i]
        return { bytes: at(im.uri), mime: im.mimeType ?? (/\.png$/i.test(im.uri) ? 'image/png' : 'image/jpeg') }
      },
    }
  }
  const { gltf, bin } = readGltf(file)
  return {
    gltf, bin,
    image: (i) => {
      const im = gltf.images[i], view = gltf.bufferViews[im.bufferView]
      return { bytes: own(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)), mime: im.mimeType ?? 'image/png' }
    },
  }
}

/** Width and height of a PNG or a baseline/progressive JPEG. */
export function imageSize(b: Uint8Array): [number, number] {
  const v = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  if (v[0] === 0x89 && v[1] === 0x50) return [v.readUInt32BE(16), v.readUInt32BE(20)]
  for (let i = 2; i + 9 < v.length;) {
    if (v[i] !== 0xff) { i++; continue }
    const m = v[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [v.readUInt16BE(i + 7), v.readUInt16BE(i + 5)]
    i += 2 + v.readUInt16BE(i + 2)
  }
  throw new Error('not a PNG or JPEG')
}

/** Pillow, reading the image from stdin and writing a JPEG at most `size` a side to stdout. */
const PILLOW = [
  'import sys, io',
  'from PIL import Image',
  'im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")',
  'n = int(sys.argv[1])',
  'if max(im.size) > n:',
  '    s = n / max(im.size)',
  '    im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.LANCZOS)',
  'out = io.BytesIO()',
  'im.save(out, "JPEG", quality=int(sys.argv[2]), optimize=True)',
  'sys.stdout.buffer.write(out.getvalue())',
].join('\n')

/**
 * The DC step of a JPEG's luminance quantization table: 1 at quality 100, 2 at 95, 3 at 90 (IJG's
 * scaling of its base table's 16), 5 at 85. Infinity when the file has none.
 */
export function jpegDcStep(b: Uint8Array): number {
  let step = Infinity
  for (let i = 2; i + 4 < b.length;) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1], length = (b[i + 2] << 8) | b[i + 3]
    if (m === 0xda) break   // start of scan: the tables are all before it
    if (m === 0xdb) for (let p = i + 4; p < i + 2 + length;) {
      const precision = b[p] >> 4, table = b[p] & 15
      if (table === 0) step = Math.min(step, precision ? (b[p + 1] << 8) | b[p + 2] : b[p + 1])
      p += 1 + 64 * (precision ? 2 : 1)
    }
    i += 2 + length
  }
  return step
}

/**
 * A map as it ships: a JPEG within TEXTURE_SIZE as it is, unless it was saved at quality 95 or more (four
 * of the Poly Haven zips are quality 100, two to three times the bytes of quality 90 for nothing a 1k map
 * shows); anything else re-encoded.
 */
export function shippedImage(src: { bytes: Buffer, mime: string }, label: string): Buffer {
  const [w, h] = imageSize(src.bytes)
  if (src.mime === 'image/jpeg' && Math.max(w, h) <= TEXTURE_SIZE && jpegDcStep(src.bytes) >= 3) return src.bytes
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const r = spawnSync(python, ['-I', '-c', PILLOW, String(TEXTURE_SIZE), String(JPEG_QUALITY)], { input: src.bytes, maxBuffer: 256 << 20 })
  if (r.status !== 0 || !r.stdout?.length)
    throw new Error(`${label}: re-encoding the ${w}x${h} map needs Python with Pillow (${python}): ${r.error?.message ?? r.stderr?.toString().trim()}`)
  return own(r.stdout)
}

// ---------------------------------------------------------------------------------------------------
// One piece as library assets
// ---------------------------------------------------------------------------------------------------

const roundTo = (arr: ArrayLike<number>, digits: number) => {
  const f = 10 ** digits
  const out = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) out[i] = Math.round(arr[i] * f) / f
  return out
}

/**
 * `Model.serialize()`'s geometry as typed arrays, the shape the shipped bundle reads back (its geometry
 * records are all `typed`): float32 throughout, so assets.bin stores 4 bytes a value, not 8.
 */
export function geometryOf(part: any) {
  return {
    positions: roundTo(part.positions, 3),
    normals: roundTo(part.normals, 3),
    tangents: [],
    bitangents: [],
    texCoords: roundTo(part.uvs, 4),
    indices: Uint32Array.from(part.indices),
  }
}

export const pub = (value: string) => ({ type: 'string', value, access: 'public' })

/** The library model, its material and its textures (with their Assets names) for one piece. */
function importPiece(spec: PieceSpec) {
  const file = path.join(SOURCE_DIR, spec.file)
  const src = readSource(file)
  const { gltf } = src
  if ((gltf.materials ?? []).length !== 1) throw new Error(`${spec.file}: expected one material, found ${(gltf.materials ?? []).length}`)

  // ----- the maps: base colour, ORM (glTF's metallicRoughness, occlusion in red where the file says so or
  // the map is Poly Haven's ARM) and normal (OpenGL-style, as glTF's is)
  const m = gltf.materials[0]
  const pbr = m.pbrMetallicRoughness ?? {}
  const textures: any[] = []
  const names: { id: string, name: string }[] = []
  const map = (texIndex: number | undefined, slot: string, label: string) => {
    if (texIndex === undefined) return undefined
    const image = src.image(gltf.textures[texIndex].source)
    const bytes = shippedImage(image, `${spec.file} ${label}`)
    const texId = textureIdOf(spec.key, slot)
    textures.push({ id: texId, mime: 'image/jpeg', config: { ...TEXTURE_CONFIG }, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
    names.push({ id: texId, name: `${spec.name} ${label}` })
    return texId
  }
  const base = map(pbr.baseColorTexture?.index, 'base', 'Base Color')
  const orm = map(pbr.metallicRoughnessTexture?.index, 'orm', 'ORM')
  const normal = map(m.normalTexture?.index, 'normal', 'Normal')
  const sameAsOrm = m.occlusionTexture && gltf.textures[m.occlusionTexture.index].source === gltf.textures[pbr.metallicRoughnessTexture?.index]?.source
  const armFile = spec.file.endsWith('.gltf.zip')   // Poly Haven: the metallicRoughness map is their ARM
  if (m.occlusionTexture && !sameAsOrm) throw new Error(`${spec.file}: an occlusion map of its own is not handled`)
  const maps: any = {}
  if (base) maps.baseColorTexture = base
  if (orm) { maps.metallicRoughnessTexture = orm; if (sameAsOrm || armFile) maps.occlusionMap = orm }
  if (normal) maps.normalMap = normal
  // With a map in a slot the map's channel IS the value (pbrGBuffer.wgsl), so the factors only show in the
  // inspector: the Valley's own materials' 0 and 1.
  const color = pbr.baseColorFactor ?? [1, 1, 1, 1]
  const material = {
    type: 'pbr', baseColor: [color[0], color[1], color[2]],
    metallic: orm ? 0 : pbr.metallicFactor ?? 1, roughness: orm ? 1 : pbr.roughnessFactor ?? 1,
    reflectance: 0.5, opacity: 1, emissiveFactor: [0, 0, 0], emissiveIntensity: 1,
    textures: maps,
    config: { side: m.doubleSided ? 'double' : 'front', wireframe: false, transparent: false, castShadow: true, probeable: true },
  }
  const textureIds = [...new Set(Object.values(maps) as string[])]
  const materialAsset = { id: materialIdOf(spec.key), name: spec.name, material, textureIds, thumbnail: '' }

  // ----- the mesh: every primitive baked by its node's world matrix, one part (one material), metres,
  // its base centre on the origin
  const parts = mergeByMaterial(partsOf(src))
  normalizeParts(parts, { scale: spec.scale ?? 1 })
  const part = parts[0]
  const nodeJson = {
    id: id(`furniture:model:${spec.key}:root`), name: spec.name, type: 'node',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    children: [{
      id: id(`furniture:model:${spec.key}:mesh`), name: spec.name, type: 'model',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
      variables: { __materialId: pub(materialAsset.id) }, spawnOnStart: true,
      model: { geometry: geometryOf(part), material: structuredClone(material) },
      animationMappings: null, stateMachine: null, ragdoll: null,
    }],
    variables: {}, spawnOnStart: true,
  }
  const model = { id: modelIdOf(spec.key), name: spec.name, nodeJson, textureIds, materialIds: [materialAsset.id], thumbnail: '' }
  return { model, material: materialAsset, textures, names, triangles: part.indices.length / 3, size: boundsOf([part]).size }
}

/** Put `asset` in `list` by id: in its place if it is there, at the end if not. */
export function upsert(list: any[], asset: any) {
  const at = list.findIndex((a: any) => a.id === asset.id)
  if (at >= 0) list[at] = asset
  else list.push(asset)
}

/** The library side for every piece: what the library already holds, and the rest (or all) imported afresh. */
function libraryPieces(bundle: any, reimport: boolean) {
  const L = bundle.libraries
  const wanted = reimport ? PIECES : PIECES.filter(p => !L.models.some((m: any) => m.id === modelIdOf(p.key)))
  if (!wanted.length) {
    log('furniture: the library already holds every piece; reusing it (--reimport rebuilds them from build/additional_valley_props)')
    return
  }
  const missing = wanted.filter(p => !fs.existsSync(path.join(SOURCE_DIR, p.file)))
  if (missing.length) throw new Error(`furniture: ${missing.map(p => p.file).join(', ')} not in ${path.relative(ROOT, SOURCE_DIR)}`)

  const created = bundle.manifest.createdAt
  let bytes = 0
  for (const spec of wanted) {
    const piece = importPiece(spec)
    upsert(L.models, piece.model)
    upsert(L.materials, piece.material)
    for (const t of piece.textures) { upsert(bundle.textures, t); bytes += t.bytes.byteLength }
    // Its Assets entries: the model, the material, and each texture's record with its source image.
    const ids = new Set([piece.model.id, piece.material.id, ...piece.textures.map(t => t.id)])
    bundle.vfs.entries = bundle.vfs.entries.filter((e: any) => !ids.has(e.assetId))
    bundle.vfs.entries.push(
      { path: `${FOLDER}/Models/${spec.name}.model`, kind: 'model', assetId: piece.model.id, created },
      { path: `${FOLDER}/Materials/${spec.name}.mat`, kind: 'material', assetId: piece.material.id, created },
    )
    for (const t of piece.names) bundle.vfs.entries.push(
      { path: `${FOLDER}/Textures/${t.name}.tex`, kind: 'texture', assetId: t.id, created },
      { path: `${FOLDER}/Textures/Source/${t.name}.jpg`, kind: 'image', assetId: t.id, created },
    )
    log(`  ${spec.name}: ${piece.triangles} triangles, ${piece.size.map((v: number) => v.toFixed(2)).join(' x ')} m, ${piece.textures.length} maps`)
  }
  for (const f of ['/Props', FOLDER, `${FOLDER}/Models`, `${FOLDER}/Materials`, `${FOLDER}/Textures`, `${FOLDER}/Textures/Source`])
    if (!bundle.vfs.folders.includes(f)) bundle.vfs.folders.push(f)
  log(`furniture: ${wanted.length} models imported, ${(bytes / 1048576).toFixed(2)} MB of maps`)
}

// ---------------------------------------------------------------------------------------------------
// The house's own triangles, and rays through them
// ---------------------------------------------------------------------------------------------------

/** Level 0 of a building, as flat triangles (9 floats each) in the building's frame. */
export function houseTriangles(lodGroup: any): Float64Array {
  const out: number[] = []
  const walk = (n: any) => {
    if (n.type === 'model' && n.model?.geometry) {
      // Level 0 and its parts sit at identity under the lodGroup (lods.mjs `placeableCopy`).
      for (const t of [n.position, n.rotation]) if (t && t.some((v: number) => v !== 0)) throw new Error(`${n.name}: a part off the building's frame`)
      const P = n.model.geometry.positions, I = n.model.geometry.indices
      for (let i = 0; i < I.length; i++) out.push(P[I[i] * 3], P[I[i] * 3 + 1], P[I[i] * 3 + 2])
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(lodGroup.children[0])
  return Float64Array.from(out)
}

/** Distance along the axis-aligned ray from `o` (axis 0/1/2, sign +-1) to the nearest triangle, or Infinity. */
export function castAxis(tris: Float64Array, o: number[], axis: number, sign: number): number {
  const a = (axis + 1) % 3, b = (axis + 2) % 3
  let best = Infinity
  for (let i = 0; i < tris.length; i += 9) {
    const pa0 = tris[i + a], pa1 = tris[i + 3 + a], pa2 = tris[i + 6 + a]
    if (o[a] < Math.min(pa0, pa1, pa2) || o[a] > Math.max(pa0, pa1, pa2)) continue
    const pb0 = tris[i + b], pb1 = tris[i + 3 + b], pb2 = tris[i + 6 + b]
    if (o[b] < Math.min(pb0, pb1, pb2) || o[b] > Math.max(pb0, pb1, pb2)) continue
    // Where the line through o along `axis` meets the triangle's plane, if inside it (barycentric in a/b).
    const d0 = pa1 - pa0, d1 = pa2 - pa0, e0 = pb1 - pb0, e1 = pb2 - pb0
    const det = d0 * e1 - d1 * e0
    if (Math.abs(det) < 1e-12) continue
    const u = ((o[a] - pa0) * e1 - (o[b] - pb0) * d1) / det
    const v = ((o[b] - pb0) * d0 - (o[a] - pa0) * e0) / det
    if (u < 0 || v < 0 || u + v > 1) continue
    const at = tris[i + axis] + u * (tris[i + 3 + axis] - tris[i + axis]) + v * (tris[i + 6 + axis] - tris[i + axis])
    const t = (at - o[axis]) * sign
    if (t > 1e-6 && t < best) best = t
  }
  return best
}

/** A piece's footprint in the house's frame: half extents along x and z, and its height. */
function footprintOf(asset: any, yaw: number) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const walk = (n: any) => {
    const P = n.model?.geometry?.positions
    if (P) for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[i + k]); max[k] = Math.max(max[k], P[i + k]) }
    for (const c of n.children ?? []) walk(c)
  }
  walk(asset.nodeJson)
  const quarter = ((Math.round(yaw / 90) % 4) + 4) % 4
  if (Math.abs(yaw - Math.round(yaw / 90) * 90) > 1e-9) throw new Error(`${asset.name}: a turn of ${yaw}° is not a quarter turn`)
  // normalizeParts centred the footprint on the origin; a quarter turn swaps its sides.
  const hx = (max[0] - min[0]) / 2, hz = (max[2] - min[2]) / 2
  return { hx: quarter % 2 ? hz : hx, hz: quarter % 2 ? hx : hz, height: max[1] - min[1] }
}

const WALLS: Record<Wall, [number, number]> = { '+x': [0, 1], '-x': [0, -1], '+z': [2, 1], '-z': [2, -1] }

/** The board height under a footprint: the median of rays cast down over it from above the floor. */
function floorUnder(tris: Float64Array, x: number, z: number, hx: number, hz: number, from: number) {
  const hits: number[] = []
  for (const fx of [-0.8, 0, 0.8]) for (const fz of [-0.8, 0, 0.8]) {
    const t = castAxis(tris, [x + fx * hx, from, z + fz * hz], 1, -1)
    if (Number.isFinite(t)) hits.push(from - t)
  }
  if (hits.length < 5) throw new Error(`no floor under (${x.toFixed(2)}, ${z.toFixed(2)})`)
  hits.sort((p, q) => p - q)
  return hits[hits.length >> 1]
}

/** Above every house's floor and under anything that overhangs it: where floor rays start. */
const FLOOR_PROBE = 1.2

/**
 * Where a piece stands: its nominal spot moved onto each wall in `against` (WALL_GAP off the nearest of
 * a grid of rays cast from inside the piece across its back, low to high), then the floor under it.
 */
export function standPiece(tris: Float64Array, asset: any, p: Placement) {
  const { hx, hz, height } = footprintOf(asset, p.yaw)
  let [x, z] = p.at
  let floor = floorUnder(tris, x, z, hx, hz, FLOOR_PROBE)
  for (let pass = 0; pass < 2; pass++) {
    for (const wall of p.against ?? []) {
      const [axis, sign] = WALLS[wall]
      const half = axis === 0 ? hx : hz, across = axis === 0 ? hz : hx
      // Every 5 % across the back (the Old House's posts are 20 cm wide), from just over the boards (its
      // walls stand on a sill beam 7 cm high and 8 cm proud) to the top or head height.
      let gap = Infinity
      for (let f = -0.95; f < 0.96; f += 0.1) for (const h of [0.04, 0.4 * height, 0.75 * height, Math.min(height - 0.03, 2.2)]) {
        const o = axis === 0 ? [x, floor + h, z + f * across] : [x + f * across, floor + h, z]
        gap = Math.min(gap, castAxis(tris, o, axis, sign) - half)
      }
      if (!Number.isFinite(gap) || gap > 1.5) throw new Error(`${p.name}: no ${wall} wall within 1.5 m of ${p.at}`)
      if (axis === 0) x += sign * (gap - WALL_GAP)
      else z += sign * (gap - WALL_GAP)
    }
    floor = floorUnder(tris, x, z, hx, hz, FLOOR_PROBE)
  }
  const r = (v: number) => Math.round(v * 1000) / 1000
  return { position: [r(x), r(floor), r(z)], hx, hz, height }
}

// ---------------------------------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------------------------------

/** A linked copy of `asset` (instantiateModelAsset's plain shape), ids derived from `key`. */
function placedCopy(asset: any, key: string, name: string, position: number[], yaw: number) {
  const copy = structuredClone(asset.nodeJson)
  let n = 0
  const rekey = (j: any) => { j.id = id(`${key}:${n++}`); for (const c of j.children ?? []) rekey(c) }
  rekey(copy)
  return {
    ...copy, name, position, rotation: [0, yaw, 0], scale: [1, 1, 1],
    variables: { __modelId: pub(asset.id), __modelBaseTRS: pub('[0,0,0,0,0,0,1,1,1]') },
    spawnOnStart: true,
    drawDistance: FURNITURE_DRAW_DISTANCE,
  }
}

/** Add or replace the furniture: the library pieces and the `Furniture` group. Idempotent. */
export function applyInteriorProps(bundle: any, options: { reimport?: boolean } = {}) {
  const data = bundle.scenes[VALLEY_SCENE]
  if (!data) throw new Error('no Valley scene')
  const root = data.scene
  const buildings = child(root, 'Buildings')
  if (!buildings) throw new Error('the Valley has no Buildings')

  libraryPieces(bundle, !!options.reimport)
  const models = new Map(bundle.libraries.models.map((m: any) => [m.id, m]))

  const candle = candleLibrary(bundle)
  const fire = candleFire(root, bundle)
  const candleGroups: any[] = []
  const groups = LAYOUT.map(({ house, group, pieces }) => {
    const lod = child(buildings, house)
    if (!lod || lod.type !== 'lodGroup') throw new Error(`no ${house} lodGroup under Buildings`)
    const tris = houseTriangles(lod)
    const slug = house.toLowerCase().replace(/\s+/g, '-')
    const stood = new Map<string, { position: number[], yaw: number, height: number }>()
    const children = pieces.map((p, i) => {
      const asset: any = models.get(modelIdOf(p.piece))
      if (!asset) throw new Error(`no library model for ${p.piece}`)
      const stand = standPiece(tris, asset, p)
      stood.set(p.name, { position: stand.position, yaw: p.yaw, height: stand.height })
      log(`  ${house} / ${p.name}: at (${stand.position.join(', ')}), turned ${p.yaw}°, ${(2 * stand.hx).toFixed(2)} x ${(2 * stand.hz).toFixed(2)} x ${stand.height.toFixed(2)} m`)
      return placedCopy(asset, `furniture:${slug}:${i}`, p.name, stand.position, p.yaw)
    })
    const lit = (CANDLES[house] ?? []).flatMap(({ on, at }) => {
      const under = stood.get(on)
      if (!under) throw new Error(`${house}: no ${on} for its candles`)
      const a = under.yaw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
      const r = (v: number) => Math.round(v * 1000) / 1000
      // The piece's turn about +Y (Ry: x' = x cos + z sin, z' = -x sin + z cos), onto its top.
      return at.map(([x, z]) => [r(under.position[0] + c * x + s * z), r(under.position[1] + under.height), r(under.position[2] - s * x + c * z)])
    })
    candleGroups.push({
      id: id(`candles:${slug}`), name: `${house} Candles`, type: 'node',
      position: [...lod.position], rotation: [...lod.rotation], scale: [1, 1, 1],
      children: lit.map((position, i) => candleNode(`candles:${slug}:${i}`, position, candle, fire)), variables: {}, spawnOnStart: true,
    })
    // The house's own frame: its position and its turn (lodGroups are never scaled here).
    if (lod.scale.some((s: number) => s !== 1)) throw new Error(`${house} is scaled`)
    return {
      id: id(`furniture:${slug}`), name: group, type: 'node',
      position: [...lod.position], rotation: [...lod.rotation], scale: [1, 1, 1],
      children, variables: {}, spawnOnStart: true,
    }
  })
  const furniture = {
    id: id('furniture'), name: 'Furniture', type: 'node',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    children: groups, variables: {}, spawnOnStart: true,
  }
  const at = root.children.findIndex((c: any) => c.id === furniture.id)
  // Whether the pieces moved at all: only then are the GI bakes round them stale.
  const moved = at < 0 || JSON.stringify(root.children[at]) !== JSON.stringify(furniture)
  if (at >= 0) root.children[at] = furniture
  else root.children.splice(root.children.indexOf(buildings) + 1, 0, furniture)
  const candles = {
    id: id('candles'), name: 'Candles', type: 'node',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    children: candleGroups, variables: {}, spawnOnStart: true,
  }
  const cat = root.children.findIndex((c: any) => c.id === candles.id)
  if (cat >= 0) root.children[cat] = candles
  else root.children.splice(root.children.indexOf(furniture) + 1, 0, candles)

  // The scene names them now: its refs list them, as the editor's own save would.
  const used = [...PIECES.map(p => models.get(modelIdOf(p.key)) as any), candle]
  for (const meta of bundle.manifest.sceneMetas) {
    if (meta.id !== VALLEY_SCENE) continue
    const refs = (meta.refs ??= {})
    refs.modelIds = [...new Set([...(refs.modelIds ?? []), ...used.map(m => m.id)])]
    refs.materialIds = [...new Set([...(refs.materialIds ?? []), ...used.flatMap(m => m.materialIds)])]
    refs.textureIds = [...new Set([...(refs.textureIds ?? []), ...used.flatMap(m => m.textureIds)])]
  }

  const count = groups.reduce((n, g) => n + g.children.length, 0)
  log(`candles: ${candleGroups.reduce((n, g) => n + g.children.length, 0)} on the furniture`)
  log(`furniture: ${count} pieces in ${groups.length} houses ${at < 0 ? 'added' : moved ? 'replaced' : 'unchanged'}`
    + (moved ? '; Hamlet GI and both Interior GI bakes are stale until `node tools/valley/bakeGI.cjs` bakes them again' : ''))
  return bundle
}

// ---------------------------------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------------------------------

/** A table candle: 0.2 m of wax on a 2 cm iron dish (dungeon/props.mjs buildCandle), its flame's root at 0.24 m. */
const CANDLE_WAX = 0.2
/** A candle's light, as build.mjs's fireLight gave the Dungeon's: 60 lm, a short reach, no shadow. */
export const CANDLE_LUMENS = 60
export const CANDLE_RANGE = 3.5
const CANDLE_FLAME = 0.13
/** Torch Fire's cell: the fire's root a tenth up it, drawn half as wide again (build.mjs TORCH_FLAME). */
const FLAME_ROOT = 0.1, FLAME_ASPECT = 0.5, FLAME_WIDEN = 1.5
export const CANDLE_MODEL = id('furniture:model:candle')
const CANDLE_MATERIAL = id('furniture:material:candle')

export interface CandleSpot { on: string, at: [number, number][] }
/**
 * The candles, by the piece of the house's LAYOUT they stand on, each spot in that piece's own frame (before
 * its turn), on its top: three down each dining table, a pair on the Long House's low table (by the rug and
 * the sunlit door), one on a cabinet in the bedroom end of each house and one on the Old House's workbench.
 */
export const CANDLES: Record<string, CandleSpot[]> = {
  'Long House': [
    { on: 'Dining Table', at: [[-0.5, 0.05], [0, -0.12], [0.5, 0.08]] },
    { on: 'Low Table', at: [[-0.18, 0], [0.18, 0.06]] },
    { on: 'Painted Cabinet', at: [[0.25, 0.05]] },
  ],
  'Old House': [
    { on: 'Dining Table', at: [[-0.5, 0.05], [0, -0.12], [0.5, 0.08]] },
    { on: 'Workbench', at: [[0.2, 0]] },
    { on: 'Painted Cabinet', at: [[-0.25, 0.05]] },
  ],
}

/** The candle's library model and its wax: built here, the same every run (no source file). */
function candleLibrary(bundle: any) {
  const { parts, flame } = buildCandle(CANDLE_WAX) as any
  if (Math.abs(flame - (CANDLE_WAX + 0.04)) > 1e-9) throw new Error('buildCandle moved its flame')
  // Wax and dish as one part: one material, the wax's.
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = []
  for (const part of parts) {
    const base = P.length / 3
    P.push(...part.positions); N.push(...part.normals); U.push(...part.uvs)
    for (const i of part.indices) I.push(i + base)
  }
  const material = {
    type: 'pbr', baseColor: [0.86, 0.8, 0.62], metallic: 0, roughness: 0.55, reflectance: 0.5, opacity: 1,
    emissiveFactor: [1, 0.6, 0.25], emissiveIntensity: 0.15, textures: {},
    config: { side: 'front', wireframe: false, transparent: false, castShadow: false, probeable: true },
  }
  const materialAsset = { id: CANDLE_MATERIAL, name: 'Candle Wax', material, textureIds: [], thumbnail: '' }
  const model = {
    id: CANDLE_MODEL, name: 'Candle', textureIds: [], materialIds: [CANDLE_MATERIAL], thumbnail: '',
    nodeJson: {
      id: id('furniture:model:candle:root'), name: 'Candle', type: 'node',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      children: [{
        id: id('furniture:model:candle:mesh'), name: 'Candle', type: 'model',
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
        variables: { __materialId: pub(CANDLE_MATERIAL) }, spawnOnStart: true,
        model: { geometry: geometryOf({ positions: P, normals: N, uvs: U, indices: I }), material: structuredClone(material) },
        animationMappings: null, stateMachine: null, ragdoll: null,
      }],
      variables: {}, spawnOnStart: true,
    },
  }
  const L = bundle.libraries
  upsert(L.models, model)
  upsert(L.materials, materialAsset)
  const created = bundle.manifest.createdAt
  const ids = new Set([CANDLE_MODEL, CANDLE_MATERIAL])
  bundle.vfs.entries = bundle.vfs.entries.filter((e: any) => !ids.has(e.assetId))
  bundle.vfs.entries.push(
    { path: `${FOLDER}/Models/Candle.model`, kind: 'model', assetId: CANDLE_MODEL, created },
    { path: `${FOLDER}/Materials/Candle Wax.mat`, kind: 'material', assetId: CANDLE_MATERIAL, created },
  )
  for (const f of ['/Props', FOLDER, `${FOLDER}/Models`, `${FOLDER}/Materials`])
    if (!bundle.vfs.folders.includes(f)) bundle.vfs.folders.push(f)
  return model
}

/** What a candle burns with: the wall torches' Torch Fire flame and the Valley's Fire Light script. */
function candleFire(root: any, bundle: any) {
  let flame: any = null
  for (const n of nodes(root)) if (n.type === 'animatedSprite' && n.name === 'Flame' && n.sprite?.tileset?.name === 'Torch Fire') { flame = n; break }
  if (!flame) throw new Error('candles: no Torch Fire flame in the scene to light them with')
  const script = bundle.libraries.scripts.find((s: any) => s.id === id('script:ValleyFireLight'))
  if (!script) throw new Error('candles: no Fire Light script in the library')
  return { sprite: flame.sprite, animation: flame.animation, script }
}

/** One candle at `position` (its house's frame): the wax, its flame and its light, under the Fire Light. */
function candleNode(key: string, position: number[], model: any, fire: { sprite: any, animation: any, script: any }) {
  const flameAt = CANDLE_WAX + 0.04
  const wax = placedCopy(model, `${key}:wax`, 'Wax', [0, 0, 0], 0)
  const n: any = {
    id: id(key), name: 'Candle', type: 'node', position, rotation: [0, 0, 0], scale: [1, 1, 1],
    children: [
      wax,
      {
        id: id(`${key}:flame`), name: 'Flame', type: 'animatedSprite',
        position: [0, flameAt - 0.01 + CANDLE_FLAME * (0.5 - FLAME_ROOT), 0], rotation: [0, 0, 0],
        scale: [CANDLE_FLAME * FLAME_ASPECT * FLAME_WIDEN, CANDLE_FLAME, 1], children: [], variables: {}, spawnOnStart: true,
        sprite: { ...structuredClone(fire.sprite), softness: 0.03 },
        animation: structuredClone(fire.animation),
      },
      {
        id: id(`${key}:light`), name: 'Light', type: 'light', position: [0, flameAt + 0.08, 0], rotation: [0, 0, 0],
        scale: [1, 1, 1], children: [], variables: {}, spawnOnStart: true, lightType: 'point', castShadows: false,
        light: { unit: 'photometric', color: [1, 0.58, 0.28], intensity: CANDLE_LUMENS, range: CANDLE_RANGE, sourceRadius: 0.02,
                 legacyFalloff: false, flicker: { amount: 0.12, speed: 7 } },
      },
    ],
    variables: {}, spawnOnStart: true, drawDistance: FURNITURE_DRAW_DISTANCE,
  }
  attach(n, fire.script, {})
  return n
}
