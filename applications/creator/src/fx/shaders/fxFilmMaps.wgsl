// Film step 5: the film drawn into the decal's three textures -- liquidRender.ts `filmMaps` on the GPU: base colour
// with coverage in alpha, a tangent-space normal map of the thickness smoothed by a cell, and the ORM map (wet
// glossy, soaked matte). The maps' row 0 is the decal image's top (-z); a texture's v runs the other way, so
// row `z` is written to `rows - 1 - z`. One thread per cell.

#include "./fxFilmCommon.wgsl"

@group(0) @binding(0) var<uniform> fu: FilmUniforms;
@group(0) @binding(1) var<storage, read> h: array<f32>;
@group(0) @binding(2) var<storage, read> stain: array<f32>;
@group(0) @binding(3) var out_color: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var out_normal: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var out_orm: texture_storage_2d<rgba8unorm, write>;

fn thickness(ix: i32, iz: i32) -> f32 {
    let i = cell_index(clamp(ix, 0, cols() - 1), clamp(iz, 0, rows() - 1));
    return h[i] + stain[i] * 0.3;
}

/** The thickness smoothed over the cell and its four neighbours. */
fn smoothed(ix: i32, iz: i32) -> f32 {
    return (thickness(ix, iz) * 2.0 + thickness(ix - 1, iz) + thickness(ix + 1, iz) + thickness(ix, iz - 1) + thickness(ix, iz + 1)) / 6.0;
}

fn enc(c: f32) -> f32 { return pow(clamp(c, 0.0, 1.0), 1.0 / 2.2); }

fn smoothstep01(a: f32, b: f32, x: f32) -> f32 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

@compute @workgroup_size(8, 8, 1)
fn cs_film_maps(@builtin(global_invocation_id) g: vec3<u32>) {
    if (!in_win(g)) { return; }
    let wc = win_cell(g);
    let ix = wc.x;
    let iz = wc.y;
    let i = cell_index(ix, iz);
    let at = vec2<i32>(ix, rows() - 1 - iz);
    let hh = h[i];
    let ss = stain[i];

    // The relief: flat where the surface is; tangent space with x along the decal's +X, y along its +Z.
    let hl = smoothed(ix - 1, iz);
    let hr = smoothed(ix + 1, iz);
    let hu = smoothed(ix, iz - 1);
    let hd = smoothed(ix, iz + 1);
    var n = vec3<f32>(0.0, 0.0, 1.0);
    if (hl != hr || hu != hd) {
        let c = fu.geom.z;
        let gx = (hr - hl) / (2.0 * c);
        let gz = (hd - hu) / (2.0 * c);
        n = normalize(vec3<f32>(-gx * fu.consts2.w, -gz * fu.consts2.w, 1.0));
    }
    textureStore(out_normal, at, vec4<f32>(n * 0.5 + vec3<f32>(0.5), 1.0));

    let metal = clamp(fu.sigma.w, 0.0, 1.0);
    if (hh == 0.0 && ss == 0.0) {
        textureStore(out_orm, at, vec4<f32>(1.0, 0.7, metal, 1.0));
        textureStore(out_color, at, vec4<f32>(0.0));
        return;
    }
    let wetShare = hh / max(1e-9, hh + ss);
    let rough = clamp(fu.consts.w + (clamp(fu.colour.w, 0.0, 1.0) - fu.consts.w) * wetShare, 0.0, 1.0);
    textureStore(out_orm, at, vec4<f32>(1.0, rough, metal, 1.0));

    // The optics: how much of the ground shows through, and what the liquid adds (liquidRender.ts `FilmOptics`).
    let dry = fu.consts.x;
    let wet = smoothstep01(dry, dry * 3.0, hh);
    let dried = smoothstep01(dry * 0.5, dry * 4.0, ss);
    let darken = 1.0 - fu.consts2.x * max(wet, dried * 0.5);
    var s = vec3<f32>(0.0);
    var tc = vec3<f32>(1.0);
    for (var c = 0; c < 3; c = c + 1) {
        let sig = fu.sigma[c];
        let alb = fu.colour[c];
        let tw = exp(-2.0 * sig * hh);
        let ts = exp(-6.0 * sig * ss);
        s[c] = alb * (1.0 - tw) + tw * alb * fu.consts.z * (1.0 - ts);
        tc[c] = tw * ts * darken;
    }
    let glassT = (tc.x + tc.y + tc.z) / 3.0;
    let cover = max(wet, dried);
    for (var c = 0; c < 3; c = c + 1) {
        s[c] = max(0.0, s[c] + fu.consts2.y * (tc[c] - glassT)) * (1.0 - metal) + fu.colour[c] * cover * metal;
    }
    let t = glassT * (1.0 - metal) + (1.0 - cover) * metal;
    let hides = 1.0 - t;
    var rgb = vec3<f32>(0.0);
    if (hides > 1e-4) { rgb = vec3<f32>(enc(s.x / hides), enc(s.y / hides), enc(s.z / hides)); }
    textureStore(out_color, at, vec4<f32>(rgb, clamp(hides / fu.misc.x, 0.0, 1.0)));
}
