// Camera see-through hole: a CameraRig in 'dither' collision mode does not pull the camera in when
// something stands between it and the player. Instead, the surfaces of the objects that opt in
// (`Node.cameraDither`, a foliage rule's `cameraDither`) are screen-door dithered away inside a
// cylinder around the camera -> pivot line. Only the part that actually blocks the view goes, so a
// pillar keeps its top and bottom, and the dither's per-frame phase lets TAA resolve it into a
// see-through blend rather than a mesh of holes.
//
// Included by chunks/modelVarying.wgsl (after VertexOutput), so it lands exactly once per program.

/**
 * Fill the hole varyings for this vertex. `a` = camera position (xyz) and 1 / hole radius (w); `b` =
 * pivot position (xyz) and this draw's strength (w, 0 = off); `phase` = the frame's dither phase.
 * Call after `fragPos` is final (wind moves it).
 */
fn cameraHoleVarying(out: ptr<function, VertexOutput>, a: vec4<f32>, b: vec4<f32>, phase: f32) {
    if (!(b.w > 0.0)) {
        (*out).camHoleParams = vec2<f32>(0.0, 0.0);
        return;
    }
    let axis = b.xyz - a.xyz;
    let rel = (*out).fragPos - a.xyz;
    let t = dot(rel, axis) / max(dot(axis, axis), 1e-6);
    (*out).camHole = vec4<f32>((rel - axis * t) * a.w, t);
    (*out).camHoleParams = vec2<f32>(b.w, phase);
}

/**
 * Whether a fragment survives the hole. Full strength inside 60% of the radius, easing out to the rim;
 * only strictly between the camera and the pivot, and fading out over the last stretch before the
 * pivot so the ground at the player's feet and anything just behind them stay solid.
 */
fn cameraHoleKeeps(hole: vec4<f32>, params: vec2<f32>, fragCoord: vec2<f32>) -> bool {
    if (!(params.x > 0.0)) { return true; }
    let d = length(hole.xyz);
    let t = hole.w;
    let hide = params.x * (1.0 - smoothstep(0.6, 1.0, d))
             * smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.82, 0.95, t));
    if (hide <= 0.0) { return true; }
    return lodDitherThreshold(fragCoord, params.y) >= hide;
}
