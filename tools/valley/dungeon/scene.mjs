// The Dungeon scene: the medieval dungeon structure, dressed, lit and populated as a souls level.
//
// build.mjs hands over its registries and builders as `kit` (materials, textures, templates, the souls
// content); this module owns the dungeon's geometry pipeline (structure.mjs, collision.mjs, props.mjs), its
// materials and props, and the scene. Every position is layout.mjs's.
//
// The generator asserts what a player needs before it writes a byte: every room in layout.REACH reachable on
// foot from the spawn over the generated colliders, with every prop's collider standing where it will.

import path from 'path'
import { boundsOf, decimate } from '../meshes.mjs'
import { loadStructure, chunkParts, doorFrames, openDoorways, removePieces } from './structure.mjs'
import { buildColliders, chunkBoxes, reachability, walkableSoup } from './collision.mjs'
import { buildBench, buildBookcase, buildCage, buildChain, buildCrate, buildLadder, buildRack, buildStaticBarrel, buildTable, buildWeapon } from './props.mjs'
import * as L from './layout.mjs'

const round = (v) => Math.round(v * 1000) / 1000
const D = '/Environment/Dungeon'
const DP = '/Props/Dungeon'

export function buildDungeon(kit) {
  const { id, node, vars, souls, withScript, linkInstance, tex, pbrMaterial, libraryMaterial, modelNode, placeFire, log } = kit

  // ===================================================================================================
  // The structure
  // ===================================================================================================

  const structure = loadStructure(path.join(kit.PROPS, L.STRUCTURE_FILE))
  for (const r of L.REMOVE_PIECES) log('dungeon', `removed ${removePieces(structure.parts, r.part, r.box)} triangles of ${r.part}`)
  const frames = doorFrames(structure.parts)
  log('dungeon', `${frames.length} door frames, ${openDoorways(structure.parts, frames)} wall triangles cut to open them`)
  const chunks = chunkParts(structure.parts)
  const triangles = structure.parts.reduce((s, p) => s + p.indices.length / 3, 0)
  log('dungeon', `${triangles} triangles in ${chunks.length} chunks`)

  // ----- materials: rocky walls and slabs from build/wall_textures, wood and metal the model's own ---------

  // No height maps: parallax marching on every wall and floor pixel cost more than any other pass on an
  // integrated GPU (about 4 ms a frame), for a relief the normal maps already mostly give.
  const textured = (key, name, prefix, extra = {}) => libraryMaterial(`dungeon-${key}`, name, `${D}/Materials`, pbrMaterial({
    diff: tex(`${prefix}_diff.jpg`, `${D}/Textures`, `${name} Base Color`),
    nor: tex(`${prefix}_nor.png`, `${D}/Textures`, `${name} Normal`),
    arm: tex(`${prefix}_arm.jpg`, `${D}/Textures`, `${name} ARM`),
    ...extra,
  }))
  const SLATES = textured('slates', 'Dungeon Castle Slates', 'castle_wall_slates')
  const COBBLES = textured('cobbles', 'Dungeon Cobblestone Floor', 'cobblestone_floor_09')
  const BRICK = textured('brick', 'Dungeon Stone Brick Wall', 'stone_brick_wall_001')
  // stone_wall_04 is a pale limestone: darkened to sit with the rest of the dungeon.
  const SLABS = textured('slabs', 'Dungeon Stone Slabs', 'stone_wall_04', { tint: [0.58, 0.56, 0.54] })
  const embedded = (key, name, extra = {}) => textured(key, name, `dungeon_${key}`, extra)
  const SKY = libraryMaterial('dungeon-sky', 'Dungeon Night Sky', `${D}/Materials`, {
    ...pbrMaterial({ diff: tex('dungeon_sky_diff.jpg', `${D}/Textures`, 'Dungeon Night Sky Base Color'), roughness: 1, castShadow: false }),
    // A window's sky glows on its own: faintly, so it reads as moonlit sky rather than a white panel.
    emissiveFactor: [0.55, 0.65, 1], emissiveIntensity: 0.45,
  })
  const MATERIALS = {
    stone_wall: SLATES, stone_slate: SLATES, stone_rubble: SLATES,
    stone_floor: COBBLES, stone_cobble: COBBLES,
    stone_brick: BRICK, stone_ashlar: BRICK,
    stone_slab: SLABS,
    stone_hewn: embedded('stone_hewn', 'Dungeon Hewn Stone'),
    wood_planks: embedded('wood_planks', 'Dungeon Wood Planks'),
    wood_old: embedded('wood_old', 'Dungeon Old Wood'),
    iron: embedded('iron', 'Dungeon Iron'), brass: embedded('brass', 'Dungeon Brass'),
    cast_iron: embedded('cast_iron', 'Dungeon Cast Iron'), gold: embedded('gold', 'Dungeon Gold'),
    sky: SKY,
    void: libraryMaterial('dungeon-void', 'Dungeon Void', `${D}/Materials`, souls.pbr([0.01, 0.01, 0.01], { roughness: 1, castShadow: false })),
  }
  for (const c of chunks) if (!MATERIALS[c.materialName]) throw new Error(`no dungeon material for "${c.materialName}"`)

  // ----- colliders -------------------------------------------------------------------------------------

  const { boxes } = buildColliders(structure.parts, structure.bounds)
  const kinds = {}
  for (const b of boxes) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1
  log('dungeon', `colliders: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`)

  // ===================================================================================================
  // Props: library models, placed as linked copies
  // ===================================================================================================

  const BOARDS = kit.SURFACES.boards
  // The joinery has uvs in metres; the planks repeat every 1.5 m on every board.
  const propMaterial = (key, name, folder, file, extra = {}) => libraryMaterial(key, name, `${DP}/Materials`, pbrMaterial({
    diff: tex(path.join(folder, `${file}_diff_1k.jpg`), `${DP}/Textures`, `${name} Base Color`),
    nor: tex(path.join(folder, `${file}_nor_gl_1k.jpg`), `${DP}/Textures`, `${name} Normal`),
    arm: tex(path.join(folder, `${file}_arm_1k.jpg`), `${DP}/Textures`, `${name} ARM`),
    ...extra,
  }))
  const prepared = (key, name, prefix, extra = {}) => libraryMaterial(key, name, `${DP}/Materials`, pbrMaterial({
    diff: tex(`${prefix}_diff.jpg`, `${DP}/Textures`, `${name} Base Color`),
    nor: tex(`${prefix}_nor.png`, `${DP}/Textures`, `${name} Normal`),
    arm: tex(`${prefix}_arm.jpg`, `${DP}/Textures`, `${name} ARM`),
    ...extra,
  }))
  const BOOKCASE_MAT = prepared('bookcase', 'Bookcase', 'bookcase', { side: 'double' })
  const barrelDir = path.join(kit.BUILD, 'props', 'wooden_barrels_01_1k.gltf')
  const BARREL2_MAT = propMaterial('barrel-dark', 'Barrel (old)', path.join(barrelDir, 'textures'), 'wooden_barrels_01_barrel02')
  const WEAPONS = {
    mace: ['ornate_medieval_mace', 'Ornate Mace'], hammer: ['ornate_war_hammer', 'War Hammer'],
    axe: ['wooden_axe', 'Wooden Axe'], saber: ['wooden_handle_saber', 'Wooden Saber'],
  }

  /** A model asset from `[part, materialId]` pairs; its nodes link their materials as the editor's do. */
  const assets = []
  const folders = {}
  function libraryModel(key, name, list, collider = null) {
    const assetId = id(`model:dungeon:${key}`)
    const children = list.map(([part, materialId], i) => modelNode(`model:dungeon:${key}:${i}`, i ? `${name} ${i + 1}` : name, part, materialId))
    const nodeJson = node(name, 'node', { id: id(`model:dungeon:${key}:root`), children })
    const materialIds = [...new Set(list.map(([, m]) => m))]
    const textureIds = [...new Set(materialIds.flatMap(m => kit.texIdsOf(kit.matJson(m))))]
    const asset = { id: assetId, name, nodeJson, textureIds, materialIds, thumbnail: '' }
    assets.push(asset)
    folders[name] = `${DP}/Models`
    const b = boundsOf(list.map(([p]) => p))
    return { asset, collider, bounds: b }
  }

  const bookcase = buildBookcase(path.join(kit.BUILD, 'props'))
  const cage = buildCage(path.join(kit.BUILD, 'props'), { height: 2.4 })
  const staticBarrel = buildStaticBarrel(path.join(barrelDir, 'wooden_barrels_01_1k.gltf'))
  // The source barrel is 11k triangles; a third of that is plenty for a barrel that never breaks.
  staticBarrel.parts = staticBarrel.parts.map(p => ({ ...decimate(kit.ROOT, p, 0.3), name: p.name }))
  const MODELS = {
    bookcase: libraryModel('bookcase', 'Bookcase', bookcase.parts.map(p => [p, BOOKCASE_MAT]), { type: 'box', size: bookcase.size }),
    cage: libraryModel('cage', 'Prisoner Cage', cage.parts.map(p => [p, kit.CAGE_MAT]), { type: 'cylinder', radius: cage.size[0] / 2, height: cage.size[1] }),
    barrel: libraryModel('barrel', 'Barrel', staticBarrel.parts.map(p => [p, BARREL2_MAT]), { type: 'cylinder', radius: staticBarrel.size[0] / 2, height: staticBarrel.size[1] }),
    crate: (() => { const c = buildCrate(); return libraryModel('crate', 'Crate', c.parts.map(p => [p, BOARDS]), { type: 'box', size: c.size }) })(),
    table: (() => { const t = buildTable(); return libraryModel('table', 'Table', t.parts.map(p => [p, BOARDS]), { type: 'box', size: t.size }) })(),
    'table:short': (() => { const t = buildTable(1.4, 0.8); return libraryModel('table-short', 'Small Table', t.parts.map(p => [p, BOARDS]), { type: 'box', size: t.size }) })(),
    bench: (() => { const b = buildBench(); return libraryModel('bench', 'Bench', b.parts.map(p => [p, BOARDS]), { type: 'box', size: b.size }) })(),
    'bench:short': (() => { const b = buildBench(1.3); return libraryModel('bench-short', 'Stool Bench', b.parts.map(p => [p, BOARDS]), { type: 'box', size: b.size }) })(),
    rack: (() => { const r = buildRack(); return libraryModel('rack', 'Weapon Rack', r.parts.map(p => [p, BOARDS])) })(),
    ladder: (() => { const l = buildLadder(L.LADDER.ceiling); return libraryModel('ladder', 'Ladder', l.parts.map(p => [p, BOARDS])) })(),
    chain: libraryModel('chain', 'Chain', buildChain().parts.map(p => [p, kit.CAGE_MAT])),
    coldFire: libraryModel('cold-fire', 'Cold Campfire', kit.campfire.parts.map(p => [p, kit.CAMPFIRE_MATS[p.material]]), { type: 'cylinder', radius: 0.75, height: 0.4 }),
  }
  for (const [key, [file, name]] of Object.entries(WEAPONS)) {
    const dir = path.join(kit.BUILD, 'props', 'weapons', `${file}_1k.gltf`)
    const w = buildWeapon(path.join(dir, `${file}_1k.gltf`))
    // The souls weapons are these same scans: their materials (and textures) are reused, not made twice.
    const mat = souls.materials.find(m => m.name === name)?.id
    if (!mat) throw new Error(`no souls weapon material "${name}"`)
    MODELS[key] = libraryModel(`weapon-${key}`, name, w.parts.map(p => [p, mat]))
    MODELS[key].weapon = w
  }
  kit.mossRocks.forEach((r, i) => {
    MODELS[`rock:${i}`] = libraryModel(`rock-${i}`, `Rubble ${'ABCD'[i]}`, [[r.part, kit.MOSS_ROCK_MAT]], { type: 'box', size: boundsOf([r.part]).size })
  })

  /** World-space AABB boxes of a placed prop's collider, for the reachability check. */
  const propBoxes = []
  let placed = 0
  /** A placed copy of a library model: its subtree re-keyed, linked by `__modelId`, a static collider. */
  function placeModel(model, key, position, rotation = [0, 0, 0], scale = [1, 1, 1]) {
    const copy = souls.clone(model.asset.nodeJson)
    let i = 0
    const rekey = (n) => { n.id = id(`dungeon:placed:${key}:${i++}`); (n.children ?? []).forEach(rekey) }
    rekey(copy)
    copy.position = position.map(round)
    copy.rotation = rotation.map(v => Math.round(v * 100) / 100)
    copy.scale = scale
    copy.variables = vars({ __modelId: model.asset.id })
    const c = model.collider
    if (c) {
      const shape = c.type === 'cylinder'
        ? { type: 'cylinder', radius: round(c.radius), height: round(c.height), numSegments: 12, offset: [0, round(c.height / 2), 0], rotation: [0, 0, 0] }
        : { type: 'box', width: round(c.size[0]), height: round(c.size[1]), depth: round(c.size[2]), offset: [0, round(c.size[1] / 2), 0], rotation: [0, 0, 0] }
      copy.body = { ...souls.staticBody('box'), shapes: [shape] }
      // For the reachability check: the footprint, turned, as an axis-aligned box.
      const yaw = rotation[1] * Math.PI / 180
      const w = c.type === 'cylinder' ? c.radius * 2 : c.size[0], d = c.type === 'cylinder' ? c.radius * 2 : c.size[2]
      const ex = Math.abs(Math.cos(yaw)) * w / 2 + Math.abs(Math.sin(yaw)) * d / 2
      const ez = Math.abs(Math.sin(yaw)) * w / 2 + Math.abs(Math.cos(yaw)) * d / 2
      const h = (c.type === 'cylinder' ? c.height : c.size[1]) * scale[1]
      propBoxes.push({ kind: 'wall', center: [position[0], position[1] + h / 2, position[2]], size: [ex * 2 * scale[0], h, ez * 2 * scale[2]], rotation: [0, 0, 0], prop: key })
    }
    placed++
    return copy
  }

  function placeProp(p, i) {
    const model = MODELS[p.model === 'rock' ? `rock:${p.variant}` : p.size ? `${p.model}:${p.size}` : p.model]
    if (!model) throw new Error(`no dungeon prop "${p.model}"`)
    const key = `${p.model}:${i}`
    if (model.weapon) {
      // Upright on a rack, or lying on the floor (turned over onto its side, its length along the yaw).
      const w = model.weapon
      if (p.pose === 'lying') {
        // Tipped forward onto its back (local +Y onto the yaw, local +Z down), so it rests on its thickness.
        return placeModel(model, key, [p.position[0], p.position[1] + w.max[2], p.position[2]], [90, p.yaw, 0])
      }
      return placeModel(model, key, p.position, [0, p.yaw, 0])
    }
    return placeModel(model, key, p.position, [0, p.yaw, 0])
  }

  // ===================================================================================================
  // The scene
  // ===================================================================================================

  function fires() {
    const out = []
    // The sconces: every torch-height light of the rig, on the wall it hangs off. Cast at the render chunks
    // within reach of the light only: the whole structure is 1.4 M triangles.
    const solidChunks = chunks.filter(c => !['Windows', 'Beams', 'Floors', 'Ceilings'].includes(c.partName))
      .map(c => ({ part: c, bounds: boundsOf([c]) }))
    let wall = 0
    for (const l of structure.lights) {
      if (l.type !== 'point' || l.index < 12 || l.index > 66 || L.SKIP_LIGHTS.has(l.index)) continue
      const solid = solidChunks.filter(({ bounds: b }) => [0, 1, 2].every(a => b.min[a] - 1.6 <= l.position[a] && b.max[a] + 1.6 >= l.position[a])).map(c => c.part)
      let best = null
      for (let a = 0; a < 8; a++) {
        const ang = a * Math.PI / 4
        const hit = kit.rayHit(solid, l.position, [l.position[0] + Math.sin(ang) * 1.5, l.position[1], l.position[2] + Math.cos(ang) * 1.5])
        if (hit && (!best || hit.t < best.t)) best = hit
      }
      if (!best || Math.abs(best.normal[1]) > 0.3) throw new Error(`light ${l.index} has no wall to hang a torch on`)
      const n = [best.normal[0], 0, best.normal[2]]
      const len = Math.hypot(n[0], n[2])
      // Snap the wall to its axis (they all are): a torch square to its wall.
      const yaw = Math.round(Math.atan2(n[0] / len, n[2] / len) * 2 / Math.PI) * 90
      const flame = kit.wallTorch.flame
      out.push(placeFire('wallTorch', `dungeon:${l.index}`,
        [round(best.point[0]), round(l.position[1] - flame[1] + 0.12), round(best.point[2])], [0, yaw, 0]))
      wall++
    }
    for (const f of L.FIRES) {
      if (f.kind === 'torch') out.push(placeFire('torch', `dungeon:${f.key}`, f.position, [0, 0, 0], [f.scale ?? 1, f.scale ?? 1, f.scale ?? 1]))
      else out.push(placeFire(f.kind, `dungeon:${f.key}`, f.position))
      if (f.chainTo) {
        // From the cage's top ring to the ceiling.
        const top = f.position[1] + kit.brazierCage.size[1]
        out.push(placeModel(MODELS.chain, `chain:${f.key}`, [f.position[0], top, f.position[2]], [0, 0, 0], [1, round(f.chainTo - top), 1]))
      }
    }
    log('dungeon', `${wall} wall torches, ${L.FIRES.length} other fires`)
    return out
  }

  /** The rig's spots: moonlight through the windows and the oculus. */
  function shafts() {
    return structure.lights.filter(l => l.type === 'spot').map(l => {
      const pitch = Math.asin(-l.direction[1]) * 180 / Math.PI
      const yaw = Math.atan2(l.direction[0], l.direction[2]) * 180 / Math.PI
      const oculus = l.index === 85
      return node(oculus ? 'Moon Shaft' : `Window Light ${l.index}`, 'light', {
        id: id(`dungeon:shaft:${l.index}`), position: l.position.map(round), rotation: [round(pitch), round(yaw), 0],
        // No shadows: a shaft reaches across a whole hall, and its map would redraw the hall every frame.
        lightType: 'spotlight', castShadows: false,
        light: {
          unit: 'photometric', color: [0.62, 0.72, 1], intensity: oculus ? L.SHAFTS.oculusLumens : L.SHAFTS.lumens,
          range: oculus ? L.SHAFTS.oculusRange : L.SHAFTS.range, sourceRadius: 0.2, legacyFalloff: false,
          cutOff: round(l.innerCone * 180 / Math.PI), outerCutOff: round(l.outerCone * 180 / Math.PI),
        },
      })
    })
  }

  /** The ladder back up: rails to a dark hatch in the ceiling, daylight falling through it, and the door. */
  function wayOut() {
    const { position: p, yaw, ceiling } = L.LADDER
    const r = yaw * Math.PI / 180, out = [Math.sin(r), Math.cos(r)]
    const hatch = node('Hatch', 'model', {
      id: id('dungeon:hatch'), position: [p[0] + out[0] * 0.45, ceiling - 0.01, p[2] + out[1] * 0.45],
      variables: vars({ __materialId: kit.CAVE_DARK_MAT }),
      model: { geometry: downQuad(1.1), material: kit.matJson(kit.CAVE_DARK_MAT) },
      animationMappings: null, stateMachine: null, ragdoll: null,
    })
    const daylight = node('Daylight', 'light', {
      id: id('dungeon:daylight'), position: [p[0] + out[0] * 0.45, ceiling - 0.1, p[2] + out[1] * 0.45], rotation: [90, 0, 0],
      lightType: 'spotlight', castShadows: false,
      light: { unit: 'photometric', color: [0.85, 0.9, 1], intensity: 2150000, range: 7, sourceRadius: 0.3, legacyFalloff: false, cutOff: 18, outerCutOff: 34 },
    })
    const door = withScript(node('Way Out', 'node', {
      id: id('dungeon:exit'), position: [p[0], p[1], p[2]], rotation: [0, yaw, 0],
      trigger: { shapes: [{ type: 'box', width: 1.8, height: 3, depth: 1.8, offset: [0, 1.5, 0.9], rotation: [0, 0, 0] }] },
    }), 'SoulsSceneDoor', {
      targetScene: kit.PROJECT_NAME, prompt: 'Climb the ladder', question: 'Return to the valley?',
      detail: 'Up through the hatch, out of the skull.', loadingTitle: 'The Valley', frontOnly: false,
      exitTo: 'Skull Cave Entrance', arrivalDistance: 1.6,
    })
    return souls.group('dungeon:way-out', 'Way Out', [placeModel(MODELS.ladder, 'ladder', p, [0, yaw, 0]), hatch, daylight, door])
  }

  function scene() {
    const structureNode = souls.group('dungeon:structure', 'Dungeon Structure',
      [...new Set(chunks.map(c => c.partName))].map(partName => souls.group(`dungeon:part:${partName}`, partName,
        chunks.filter(c => c.partName === partName).map((c, i) =>
          modelNode(`dungeon:chunk:${partName}:${i}`, c.name, c, MATERIALS[c.materialName])))))

    // The colliders, one static body per 10 m cell and per role: walls (which swings bounce off and the
    // navmesh carves round) apart from floors, ramps and wedges (which it walks on).
    const collision = []
    for (const role of ['walls', 'floors']) {
      const mine = boxes.filter(b => role === 'walls' ? b.kind === 'wall' || b.kind === 'ceiling' : b.kind !== 'wall' && b.kind !== 'ceiling')
      for (const { key, boxes: list } of chunkBoxes(mine, 10)) {
        const [cx, cz] = key.split(',').map(v => (parseInt(v) + 0.5) * 10)
        const n = node(`${role === 'walls' ? 'Walls' : 'Floors'} ${key}`, 'node', {
          id: id(`dungeon:collision:${role}:${key}`), position: [cx, 0, cz],
          variables: vars(role === 'walls' ? { blocksSwings: true } : { navObstacle: false }),
        })
        n.body = {
          ...souls.staticBody('box'),
          shapes: list.map(b => ({
            type: 'box', width: b.size[0], height: b.size[1], depth: b.size[2],
            offset: [round(b.center[0] - cx), b.center[1], round(b.center[2] - cz)], rotation: b.rotation,
          })),
        }
        collision.push(n)
      }
    }

    const props = souls.group('dungeon:props', 'Props', L.PROPS.map(placeProp))
    const fireNodes = fires()
    const barrels = souls.group('dungeon:barrels', 'Barrels', L.BREAKABLES.map((p, i) =>
      linkInstance(kit.BARREL_TEMPLATE, kit.breakableBarrelNode(`dungeon:${i}`, p, Math.round((i * 137) % 360)))))

    const bonfire = placeFire('bonfire', 'dungeon', L.BONFIRE.position, [0, L.BONFIRE.yaw, 0])
    const fog = souls.fogGateNode()
    fog.position = L.FOG_GATE.position
    fog.rotation = [0, L.FOG_GATE.yaw, 0]
    fog.scale = L.FOG_GATE.scale
    const interactables = souls.group('dungeon:interactables', 'Interactables', [
      bonfire,
      ...L.MESSAGES.map(([key, title, text, at, yaw]) => souls.placedMessage(`dungeon:${key}`, title, text, at, yaw)),
      ...L.PICKUPS.map(([key, name, at, fields]) => souls.placedPickup(`dungeon:${key}`, name, at, fields)),
      epilogue(),
      linkInstance(souls.LEVEL.fogGate, fog),
      node('Boss Arena', 'node', {
        id: id('dungeon:arena-zone'), position: L.ARENA_ZONE.position,
        variables: vars({ isBossArena: true }),
        trigger: { shapes: [{ type: 'box', width: L.ARENA_ZONE.size[0], height: L.ARENA_ZONE.size[1], depth: L.ARENA_ZONE.size[2], offset: [0, L.ARENA_ZONE.size[1] / 2, 0], rotation: [0, 0, 0] }] },
      }),
    ])
    const spawns = souls.group('dungeon:spawns', 'Enemy Spawns', [
      ...L.ENEMIES.map(([key, name, at, yaw, templateName]) => souls.placedSpawn(`dungeon:${key}`, name, at, yaw, { templateName })),
      souls.placedSpawn('dungeon:warden', 'Spawn Hollow Warden', L.BOSS.position, L.BOSS.yaw, { templateName: 'Hollow Warden', isBossSpawn: true }),
    ])

    const player = souls.playerNode()
    kit.widenCamera(player)
    player.position = L.SPAWN.position
    player.rotation = [0, L.SPAWN.yaw, 0]

    const b = structure.bounds
    const navMesh = node('Nav Mesh', 'navMesh', {
      id: id('dungeon:navmesh'), bake: {}, agentRadius: 0.45,
      position: [round((b.min[0] + b.max[0]) / 2), round((b.min[1] + b.max[1]) / 2), round((b.min[2] + b.max[2]) / 2)],
      size: [round(b.size[0] + 2), round(b.size[1] + 2), round(b.size[2] + 2)],
    })

    const root = node('root', 'node', {
      id: id('dungeon:root'),
      children: [
        withScript(node('GameManager', 'node', {
          id: id('dungeon:manager'), children: [souls.banner(), souls.soundsGroup('dungeon:manager', souls.SOUNDS.manager, { music: souls.MUSIC_CUES })],
        }), 'SoulsGameManager'),
        linkInstance(souls.LEVEL.player, player),
        souls.group('dungeon:level', 'Level', [structureNode, souls.group('dungeon:collision', 'Collision', collision)]),
        props, barrels,
        souls.group('dungeon:fires', 'Fires', fireNodes),
        souls.group('dungeon:shafts', 'Moonlight', shafts()),
        wayOut(),
        interactables, spawns, navMesh,
      ],
      // Near black and cool: what a torch does not reach, the eye barely makes out.
      ambientLight: [1250, 1400, 2040],
    })

    // The navmesh is the walkable area the reachability check found (see walkableSoup): already clear of
    // every wall and prop, so nothing is carved.
    const reach = checkReach()
    const baked = souls.navBaker.bakeInto(navMesh, { soups: [walkableSoup(reach)], settings: { carve: false } })
    log('dungeon', `navmesh ${baked.regions} regions, ${baked.ms} ms, ${(baked.bytes / 1e6).toFixed(1)} MB; ${placed} props placed`)

    const config = souls.clone(souls.sourceScene.config)
    config.graphics.clearColor = [0.004, 0.004, 0.006, 1]
    config.render.clearColor = [0.004, 0.004, 0.006, 1]
    // A held exposure (metering would lift the dark to grey), EV 15: the valley's noon. Darker would be truer
    // to a torch-lit room, and would blow out every glyph, glow and bolt the souls content is tuned for; the
    // fires are lit for this instead (see fireLight in build.mjs). The valley's lens.
    Object.assign(config.render, {
      exposure: kit.REFERENCE_ILLUMINANCE / (1.2 * 2 ** 15), autoExposureEnabled: false, quality: 'high', motionBlurEnabled: true,
      ...kit.PRESETS.look, ...kit.PRESETS.dof, dofFocusDistance: kit.PLAYER_ARM,
      pointShadowsEnabled: true, pointShadowResolution: 512, pointShadowDistance: 20,
    })
    return { scene: root, textures: [], ui: { version: 1, elements: [] }, config, assetHashes: {}, assetHashVersion: kit.ASSET_HASH_VERSION, savedAt: souls.CREATED_AT }
  }

  function epilogue() {
    const m = souls.messageNode('dungeon:epilogue', 'The Warden rests', 'The dungeon falls silent.\nThank you for playing the Valley.', L.EPILOGUE.position, L.EPILOGUE.yaw)
    m.name = 'Epilogue Message'
    m.scriptVars.hiddenUntilRevealed = true
    return linkInstance(souls.LEVEL.message, m)
  }

  /** Every room of layout.REACH, and every enemy, reachable from the spawn over the colliders, props included. */
  function checkReach() {
    const reach = reachability([...boxes, ...propBoxes], L.SPAWN.position)
    const targets = [...Object.entries(L.REACH), ...L.ENEMIES.map(([, name, at]) => [name, at]), ['the Warden', L.BOSS.position]]
    const missing = targets.filter(([, p]) => !reach.reaches(p)).map(([name]) => name)
    if (missing.length) throw new Error(`dungeon: cannot walk from the spawn to ${missing.join(', ')}`)
    log('dungeon', `every room and enemy reachable on foot (${reach.cells.size} cells)`)
    return reach
  }

  return { scene, models: assets, folders }
}

/** A square card `size` across facing down (-Y), centred on the origin. */
function downQuad(size) {
  const h = size / 2
  return {
    positions: [-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h], normals: [0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0],
    tangents: [], bitangents: [], texCoords: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3],
  }
}
