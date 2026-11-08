// The engine presets the FPS arena's look is made of, resolved for the generator.
//
//     npx vite-node --config vitest.config.ts tools/fps/presets.ts > tools/fps/presets.json
//
// Prints one object, each key the `options` of one named preset from the engine's own tables, so the arena's
// look is the presets', not hand-tuned numbers. (Run through vite-node because the tables are TypeScript and
// the light presets need the engine's colour-temperature maths.)

import { applyPreset, type Preset } from '../../src/core/presets'
import { AUTO_EXPOSURE_PRESETS, DOF_PRESETS, LENS_LOOK_PRESETS } from '../../src/graphics/renderPresets'
import { DIRECTIONAL_LIGHT_PRESETS } from '../../src/graphics/lightPresets'
import { SKY_ATMOSPHERE_PRESETS } from '../../src/core/scene/nodes/skyAtmospherePresets'
import { VOLUMETRIC_CLOUDS_PRESETS } from '../../src/core/scene/nodes/volumetricCloudsPresets'
import { WIND_PRESETS } from '../../src/core/scene/nodes/windPresets'
import { WEATHER_PRESETS } from '../../src/core/scene/nodes/weatherPresets'
import { VOLUMETRIC_FOG_PRESETS } from '../../src/core/scene/nodes/volumetricFogNode'

function options<O extends object>(table: readonly Preset<O>[], id: string): O {
    const preset = table.find(p => p.id === id)
    if (!preset) throw new Error(`no preset '${id}' (have: ${table.map(p => p.id).join(', ')})`)
    const out = {}
    applyPreset(out, table, preset)
    return out as O
}

process.stdout.write(JSON.stringify({
    exposure: options(AUTO_EXPOSURE_PRESETS, 'outdoor'),
    interiorExposure: options(AUTO_EXPOSURE_PRESETS, 'interior'),
    look: options(LENS_LOOK_PRESETS, 'cinematic'),
    dof: options(DOF_PRESETS, 'subtle'),
    sky: options(SKY_ATMOSPHERE_PRESETS, 'crisp'),
    clouds: options(VOLUMETRIC_CLOUDS_PRESETS, 'partlyCloudy'),
    wind: options(WIND_PRESETS, 'breezy'),
    sun: options(DIRECTIONAL_LIGHT_PRESETS, 'goldenHour'),
    weatherDry: options(WEATHER_PRESETS, 'dry'),
    weatherRain: options(WEATHER_PRESETS, 'drizzle'),
    groundFog: options(VOLUMETRIC_FOG_PRESETS, 'groundFog'),
    dust: options(VOLUMETRIC_FOG_PRESETS, 'dust'),
}))
