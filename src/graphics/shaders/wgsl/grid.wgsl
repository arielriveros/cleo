// Infinite editor reference grid drawn as a single fullscreen pass.
//
// For every pixel we reconstruct a world-space ray from the inverse view-projection, intersect it with
// the grid plane, and draw anti-aliased lines using screen-space derivatives (fwidth). Depth comes from
// the world hit so scene geometry occludes the grid correctly. Line density adapts to zoom: a 0.1u
// subgrid fades in when zoomed in for precise positioning, and the 1u / 10u levels cross-fade so the
// grid never aliases into moire when zoomed out.

#include "./chunks/fullscreen.wgsl"

struct GridUniforms {
    u_invViewProj: mat4x4<f32>,   // reconstruct the per-pixel world ray
    u_viewProj: mat4x4<f32>,      // project the world hit -> frag depth
    u_viewPos: vec3<f32>,         // camera world position (distance fade)
    u_fadeFar: f32,               // world-space radius where the grid fully fades out
    u_plane: i32,                 // 0 = XZ ground plane (3D), 1 = XY front plane (2D)
};
@group(1) @binding(0) var<uniform> u_grid: GridUniforms;

/**
 * Anti-aliased grid coverage for a given cell size. Returns ~1 on a line, 0 inside a cell, feathered to
 * roughly one pixel wide regardless of zoom.
 */
fn gridLine(coord: vec2<f32>, scale: f32) -> f32 {
    let g = coord / scale;
    let d = fwidth(g);
    let l = abs(fract(g - 0.5) - 0.5) / max(d, vec2<f32>(1e-8));
    return 1.0 - clamp(min(l.x, l.y), 0.0, 1.0);
}

/**
 * Anti-aliased coverage for a single centre axis at c == 0.
 *
 * Measures distance from the axis in PIXELS using c's own screen-space derivative, so the line keeps a
 * constant ~1px width instead of smearing into a wide band at grazing/horizon angles.
 */
fn axisLine(c: f32) -> f32 {
    let d = fwidth(c);
    return 1.0 - clamp(abs(c) / max(d, 1e-8) - 1.0, 0.0, 1.0);
}

// Depth is written alongside the colour so the LEQUAL test can hide the grid behind geometry.
struct GridOut {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

@fragment
fn fs_main(in: VertexOutput) -> GridOut {
    // 1. Reconstruct the world-space ray through this pixel (near -> far).
    let ndc = in.uv * 2.0 - 1.0;
    let nW = u_grid.u_invViewProj * vec4<f32>(ndc, -1.0, 1.0);
    let fW = u_grid.u_invViewProj * vec4<f32>(ndc, 1.0, 1.0);
    let ro = nW.xyz / nW.w;
    let rd = fW.xyz / fW.w - ro;

    // 2. Intersect the grid plane (Y=0 for XZ, Z=0 for XY).
    var denom = rd.z;
    var orig = ro.z;
    if (u_grid.u_plane == 0) { denom = rd.y; orig = ro.y; }
    if (abs(denom) < 1e-6) { discard; }          // ray parallel to the plane
    let t = -orig / denom;
    if (t < 0.0 || t > 1.0) { discard; }         // behind the camera or beyond far
    let hit = ro + t * rd;
    var coord = hit.xy;
    if (u_grid.u_plane == 0) { coord = hit.xz; }

    // 3. Adaptive multi-level lines. Coverage = pixels spanned by one cell; each level fades based on
    //    how many pixels its cells occupy so density stays readable.
    let px = max(fwidth(coord.x), fwidth(coord.y));   // world units per pixel

    let minorFade = smoothstep(6.0, 20.0, 0.1 / px);  // subgrid: appears when zoomed in
    let majorFade = smoothstep(2.0, 8.0, 1.0 / px);   // primary 1u: fades out far away
    let coarseFade = smoothstep(2.0, 8.0, 10.0 / px); // 10u: carries the far view

    let minor = gridLine(coord, 0.1) * minorFade;
    let major = gridLine(coord, 1.0) * majorFade;
    let coarse = gridLine(coord, 10.0) * coarseFade;

    var a = 0.0;
    a = max(a, minor * 0.45);   // subgrid dimmer than the primary lines
    a = max(a, major);
    a = max(a, coarse);
    // Neutral grey lines. The grid is composited in linear HDR and then exposed/tonemapped with the
    // scene, which amplifies bright values — keep this low so the grid reads as a subtle grey.
    var col = vec3<f32>(0.22);

    // 4. Coloured centre axes baked into the grid (the two in-plane axes). AA, constant pixel width
    //    (see axisLine) so they stay thin and do not band out at the horizon.
    //    coord.y == 0 is the X axis in both planes (points with z=0 or y=0) -> red.
    //    coord.x == 0 is the in-plane depth/vertical axis -> Z (ground, blue) or Y (front, green).
    let xAxis = axisLine(coord.x);
    let yAxis = axisLine(coord.y);
    if (yAxis > 0.0) { col = vec3<f32>(0.55, 0.18, 0.18); a = max(a, yAxis); }   // X = red (dimmed)
    if (xAxis > 0.0) {
        if (u_grid.u_plane == 0) { col = vec3<f32>(0.18, 0.30, 0.60); }         // Z = blue (3D ground)
        else { col = vec3<f32>(0.20, 0.55, 0.24); }                             // Y = green (2D front)
        a = max(a, xAxis);
    }

    // 5. Distance fade => infinite illusion and no far-field shimmer.
    let dist = length(hit - u_grid.u_viewPos);
    a *= 1.0 - smoothstep(u_grid.u_fadeFar * 0.5, u_grid.u_fadeFar, dist);

    // Overall grid opacity: keep the grid a subtle overlay that does not dominate the scene. Also limits
    // how much of the bloom mask the lines erase (grid alpha doubles as the mask-erase factor).
    a *= 0.5;

    if (a <= 0.0) { discard; }

    // depthMask is off during this pass, so this value is only used for the LEQUAL test, not written.
    let clip = u_grid.u_viewProj * vec4<f32>(hit, 1.0);

    var out: GridOut;
    out.color = vec4<f32>(col, a);
    out.depth = (clip.z / clip.w) * 0.5 + 0.5;
    return out;
}
