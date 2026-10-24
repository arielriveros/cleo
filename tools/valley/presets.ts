// The engine presets the Valley's look is made of, resolved for the generator.
//
//     npx vite-node --config vitest.config.ts tools/valley/presets.ts < request.json
//
// request.json: `{ "ambientLux": 9500 }` — the scene's ambient, which the sun preset is brightened against.
// Prints `{ exposure, look, dof, sky, clouds, wind, water, sun }`: each the `options` of one named preset from the
// engine's own tables, so the example's look is the presets', not hand-tuned numbers. Run through vite-node
// because the tables are TypeScript and the light presets need the engine's colour-temperature maths.

import { readFileSync } from 'node:fs'
import { applyPreset, type Preset } from '../../src/core/presets'
import { AUTO_EXPOSURE_PRESETS, DOF_PRESETS, LENS_LOOK_PRESETS } from '../../src/graphics/renderPresets'
import { DIRECTIONAL_LIGHT_PRESETS, presetForScene } from '../../src/graphics/lightPresets'
import { SKY_ATMOSPHERE_PRESETS } from '../../src/core/scene/nodes/skyAtmospherePresets'
import { VOLUMETRIC_CLOUDS_PRESETS } from '../../src/core/scene/nodes/volumetricCloudsPresets'
import { WIND_PRESETS } from '../../src/core/scene/nodes/windPresets'
import { WATER_VOLUME_PRESETS } from '../../src/core/scene/nodes/waterVolumePresets'

/** One preset's options, by id — a typo is an error rather than a silently missing look. */
function options<O extends object>(table: readonly Preset<O>[], id: string): O {
    const preset = table.find(p => p.id === id)
    if (!preset) throw new Error(`no preset '${id}' (have: ${table.map(p => p.id).join(', ')})`)
    // Through applyPreset onto a plain record, so arrays come out copied exactly as a node would get them.
    const out = {}
    applyPreset(out, table, preset)
    return out as O
}

const request = JSON.parse(readFileSync(0, 'utf8')) as { ambientLux: number }

const sun = DIRECTIONAL_LIGHT_PRESETS.find(p => p.id === 'morning')!

process.stdout.write(JSON.stringify({
    // A fixed exposure for a sunny exterior, as a film camera would hold it, and the cinematic lens. A metered
    // one lifts the shade and the cloud shadows to grey, which is exactly the contrast a cinematic image wants.
    exposure: options(AUTO_EXPOSURE_PRESETS, 'sunny16'),
    look: options(LENS_LOOK_PRESETS, 'cinematic'),
    dof: options(DOF_PRESETS, 'cinematic'),
    sky: options(SKY_ATMOSPHERE_PRESETS, 'hazy'),
    // Scattered fair-weather cumulus: mostly sun, with cloud shadows sweeping through. Partly Cloudy's half
    // cover left the playable valley under one shadow most of the time, which flattened it.
    clouds: options(VOLUMETRIC_CLOUDS_PRESETS, 'sunny'),
    wind: options(WIND_PRESETS, 'breezy'),
    water: options(WATER_VOLUME_PRESETS, 'lake'),
    // Brightened against the valley's ambient, as the inspector does, so it reads as a morning sun there.
    sun: presetForScene(sun, { ev100: 15, ambientLux: request.ambientLux }).options,
}))
