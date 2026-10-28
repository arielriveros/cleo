// The engine presets the Valley's look is made of, resolved for the generator.
//
//     npx vite-node --config vitest.config.ts tools/valley/presets.ts
//
// Prints `{ exposure, look, dof, sky, clouds, wind, water, sun }`: each the `options` of one named preset from the
// engine's own tables, so the example's look is the presets', not hand-tuned numbers. Run through vite-node
// because the tables are TypeScript and the light presets need the engine's colour-temperature maths.

import { applyPreset, type Preset } from '../../src/core/presets'
import { AUTO_EXPOSURE_PRESETS, DOF_PRESETS, LENS_LOOK_PRESETS } from '../../src/graphics/renderPresets'
import { DIRECTIONAL_LIGHT_PRESETS } from '../../src/graphics/lightPresets'
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

process.stdout.write(JSON.stringify({
    // Metered from noon to midnight, with the Day–Night curve holding the night darker than a fully adapted
    // eye would: the lights keep their real values all day and the exposure follows them. The cinematic lens.
    exposure: options(AUTO_EXPOSURE_PRESETS, 'dayNight'),
    // The dungeon: metered too, slow to adapt to the dark, its curve keeping a torch-lit crypt a crypt.
    caveExposure: options(AUTO_EXPOSURE_PRESETS, 'cave'),
    look: options(LENS_LOOK_PRESETS, 'cinematic'),
    dof: options(DOF_PRESETS, 'cinematic'),
    // Clear, dry air: Hazy Summer's milky halo washed the whole sky white round the sun.
    sky: options(SKY_ATMOSPHERE_PRESETS, 'crisp'),
    // Scattered fair-weather cumulus: mostly sun, with cloud shadows sweeping through. Partly Cloudy's half
    // cover left the playable valley under one shadow most of the time, which flattened it.
    clouds: options(VOLUMETRIC_CLOUDS_PRESETS, 'sunny'),
    wind: options(WIND_PRESETS, 'breezy'),
    water: options(WATER_VOLUME_PRESETS, 'lake'),
    // As stored: real lux. The Time of Day takes the sun from there.
    sun: options(DIRECTIONAL_LIGHT_PRESETS, 'morning'),
}))
