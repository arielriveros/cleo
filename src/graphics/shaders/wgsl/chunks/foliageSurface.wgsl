// The FOLIAGE material's surface behaviour (Material.Foliage), in the G-buffer stage of the foliage variants
// only (`CLEO_FOLIAGE`): no other material compiles any of this.
//
//   VARIATION. A field of one asset should not read as copies. Each plant hashes where it stands (the
//   vertex stage sends the hash) into a hue turn, a brightness and whether it is one of the dry ones.
//   GUSTS. The gust the wind is giving this plant (also from the vertex stage, 0 without wind) brightens it
//   a little -- a gust front rolling over a meadow shows as a travelling sheen -- and turns leaves over to
//   show their paler undersides.
//   WEATHER. The weather volumes the plant stands in (WeatherNode), per plant, kept off it under shelter:
//   rain darkens the surface and makes it glossy, snow settles on what faces up. The weight both put on
//   the plant is a vertex bend (chunks/foliageWind.wgsl `droop`).
//
// Included by chunks/pbrGBuffer.wgsl under `#if CLEO_FOLIAGE`; it uses chunks/foliageWind.wgsl's noise,
// which the instanced vertex stage brings in.

const FOLIAGE_LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

/** `c` turned about the grey axis by `turns` of a full hue circle (Rodrigues' rotation). */
fn foliageHueTurn(c: vec3<f32>, turns: f32) -> vec3<f32> {
    let k = vec3<f32>(0.57735027);
    let a = turns * 6.2831853;
    let ca = cos(a);
    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

/** `tint`'s hue at `c`'s brightness: recolours without lightening or darkening. */
fn foliageRecolour(c: vec3<f32>, tint: vec3<f32>) -> vec3<f32> {
    return tint * (dot(c, FOLIAGE_LUMA) / max(dot(tint, FOLIAGE_LUMA), 1e-4));
}

/**
 * Apply variation, gusts and weather to a foliage fragment. `f` is the vertex stage's `foliage` varying:
 * x = the plant's hash, y = its gust (0..~1, 0 without wind), z = 1 for a leaves material. `weather` is
 * its `foliageWeather`: x = wet, y = snow at this plant.
 */
fn foliageShade(albedo: ptr<function, vec3<f32>>, roughness: ptr<function, f32>, translucency: ptr<function, f32>,
                N: vec3<f32>, worldPos: vec3<f32>, f: vec4<f32>, weather: vec2<f32>) {
    var c = *albedo;
    // Variation: three independent numbers from one hash.
    let h = f.x;
    let h2 = fract(h * 7.31 + 0.13);
    let h3 = fract(h * 13.7 + 0.71);
    c = max(foliageHueTurn(c, (h - 0.5) * 2.0 * u_material.variationHue), vec3<f32>(0.0));
    c *= 1.0 + (h2 - 0.5) * 2.0 * u_material.variationValue;
    let dryShare = u_material.variationDry;
    let dry = select(0.0, 1.0 - smoothstep(dryShare - 0.04, dryShare + 0.04, h3), dryShare > 1e-4);
    c = mix(c, foliageRecolour(c, u_material.dryColor), dry * 0.85);

    // Gusts: a travelling sheen, and leaves turned to show their backs.
    let gust = f.y;
    c *= 1.0 + u_material.rippleSheen * (gust - 0.35) * 0.45;
    if (f.z > 0.5 && u_material.leafFlip > 0.0) {
        let turned = u_material.leafFlip * smoothstep(0.35, 0.9, gust) * windNoise(worldPos.xz * 3.1 + vec2<f32>(worldPos.y * 2.3, 0.0));
        c = mix(c, foliageRecolour(c, u_material.undersideColor) * 1.3, turned);
    }

    // Weather, per plant (the volumes it stands in, kept off it under shelter): wet is darker and
    // glossier; snow, in the weather's snow colour, settles on what faces up and lets little light through.
    let wet = saturate(weather.x * u_material.wetResponse);
    c *= mix(1.0, 0.55, wet);
    *roughness = mix(*roughness, 0.25, wet);
    let cover = saturate(weather.y * u_material.snowCover) * smoothstep(0.2, 0.8, N.y);
    c = mix(c, u_material.foliageSnow.rgb, cover);
    *roughness = mix(*roughness, u_material.foliageSnow.a, cover);
    *translucency = *translucency * (1.0 - cover);

    *albedo = c;
}
