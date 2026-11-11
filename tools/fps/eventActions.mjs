// Firing Line: the effects a shot, a reload, an equip and a death have, as Event Actions on the controllers and
// markers on the clips (src/animation/eventActions.ts), instead of code in the scripts.
//
// Applied by ingest.mjs to every pack (idempotent): it sets markers on the clips, sets each controller's bindings, and
// puts the same bindings on every embedded copy of a machine (nodes in templates, the model library and scenes carry
// their own, tagged with the controller's id).
//
//   weapon clips   Fire / AimFire    `shot`    (the weapon's sound, and the muzzle flash on the viewmodel's muzzle)
//                  Reload (shotgun: ReloadStart)  `reload`
//                  Equip             `equip`
//   bot clips      Fps_Death*        `death`
//   bots fire `shot.<weapon>` by name from script (they have no fire clip)
//
// Markers are at time 0, which fires with the clip.

const WEAPONS = {
  'AK-47': { controller: 'AK-47 Viewmodel', shot: 'ShotRifle', reloadClip: 'Reload', fire: ['Fire', 'AimFire'] },
  Pistol: { controller: 'Pistol Viewmodel', shot: 'ShotPistol', reloadClip: 'Reload', fire: ['Fire', 'AimFire'] },
  'SAPS-12': { controller: 'SAPS-12 Viewmodel', shot: 'ShotShotgun', reloadClip: 'ReloadStart', fire: ['Fire'] },
}

/** Bot weapon -> the event its shot fires, and the weapon node whose Muzzle the flash sits on. */
const BOT_WEAPONS = { ak47: 'AK-47', pistol: 'Pistol', shotgun: 'SAPS-12' }

const FLASH = 'FPS Muzzle Flash'

const viewmodelBindings = (w) => [
  { event: 'shot', actions: [
    { kind: 'sound', target: `Sounds/${w.shot}` },
    { kind: 'spawn', template: FLASH, at: 'Muzzle', rotation: 'camera', follow: true },
  ] },
  { event: 'reload', actions: [{ kind: 'sound', target: 'Sounds/Reload' }] },
  { event: 'equip', actions: [{ kind: 'sound', target: 'Sounds/Equip' }] },
]

const botBindings = () => [
  ...Object.entries(BOT_WEAPONS).map(([key, node]) => ({
    event: `shot.${key}`,
    actions: [
      { kind: 'sound', target: 'Sounds/Shot' },
      { kind: 'spawn', template: FLASH, at: `${node}/Muzzle`, rotation: 'owner', follow: true },
    ],
  })),
  { event: 'death', actions: [{ kind: 'sound', target: 'Sounds/Death' }] },
]

/** Clip name -> event, per animation asset name. */
function clipEvents() {
  const out = new Map()
  const add = (asset, name) => out.set(asset, name)
  for (const [weapon, w] of Object.entries(WEAPONS)) {
    for (const clip of w.fire) add(`${weapon} ${clip}`, 'shot')
    add(`${weapon} ${w.reloadClip}`, 'reload')
    add(`${weapon} Equip`, 'equip')
  }
  return out
}

const walk = (node, fn) => { fn(node); for (const c of node.children ?? []) walk(c, fn) }

/** Apply the markers and bindings to an inflated bundle (readBundle's `bundle`). Returns what it set. */
export function applyEventActions(bundle) {
  const stats = { markers: 0, controllers: 0, machines: 0 }
  const lib = bundle.libraries

  // ----- markers on the clips
  const wanted = clipEvents()
  for (const asset of lib.animations ?? []) {
    const name = wanted.get(asset.name) ?? (/^Fps_Death/.test(asset.name) ? 'death' : null)
    if (!name) continue
    for (const clip of asset.clips ?? []) {
      const events = clip.events ?? (clip.events = [])
      if (!events.some(e => e.name === name)) { events.push({ time: 0, name }); stats.markers++ }
    }
  }

  // ----- bindings on the controllers, and on every embedded copy of a machine
  const byId = new Map()
  for (const c of lib.animControllers ?? []) {
    const weapon = Object.values(WEAPONS).find(w => w.controller === c.name)
    const bindings = weapon ? viewmodelBindings(weapon) : c.name === 'Fps Bot' ? botBindings() : null
    if (!bindings) continue
    c.machine.eventActions = bindings
    byId.set(c.id, bindings)
    stats.controllers++
  }
  const patch = (node) => walk(node, (n) => {
    const id = n.stateMachine?.controllerId
    if (id && byId.has(id)) { n.stateMachine.eventActions = byId.get(id); stats.machines++ }
  })
  for (const t of lib.templates ?? []) patch(t.nodeJson)
  for (const m of lib.models ?? []) if (m.nodeJson) patch(m.nodeJson)
  for (const scene of Object.values(bundle.scenes ?? {})) patch(scene.scene)
  return stats
}
