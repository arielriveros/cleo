#version 300 es

precision highp float;

// One z-slice of a TILEABLE 3D noise volume, baked once at startup and thereafter sampled by
// volumetricClouds.fs instead of being recomputed per raymarch step.
//
// WHY BAKE: the cloud raymarch evaluated a 4-octave FBM (32 hash+lerp taps) for every primary sample
// and a 3-octave FBM again for detail erosion, plus the same 4-octave field for every secondary
// sun-march sample. At 40 primary x 5 light steps that is thousands of hash evaluations per pixel to
// reproduce a field that never changes. Two trilinear texture fetches give the same answer.
//
// WHY TILEABLE (and what it costs): a texture can only stand in for an infinite procedural field if
// the field repeats at the texture's period. So the value noise below hashes lattice cells modulo a
// per-octave period rather than hashing raw coordinates. The visible consequence is that the cloud
// field now repeats — see BASE_PERIOD in the renderer for the world-space distance that works out to.
//
// The renderer draws this once per slice with gl.framebufferTextureLayer; u_slice is the slice's
// centre in [0,1] along z.

uniform float u_slice;      // z coordinate of this layer, at texel centre
uniform float u_period;     // lattice cells across the volume at octave 0 (the tiling period)
uniform int   u_octaves;    // octaves in the R channel FBM
uniform bool  u_detail;     // true when baking the small high-frequency detail volume

in vec2 fragTexCoord;
out vec4 outColor;

// Hash of an INTEGER lattice cell. Taking a vec3 of whole numbers (already wrapped to the period by
// the caller) rather than a continuous position is what makes the field exactly periodic.
float hashCell(vec3 c) {
    c = fract(c * 0.1031);
    c += dot(c, c.zyx + 31.32);
    return fract((c.x + c.y) * c.z);
}

// Value noise with an explicit lattice period: cells wrap at `period`, so the field tiles seamlessly
// when the texture is sampled with REPEAT wrapping.
float valueNoiseTiled(vec3 x, float period) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f); // smoothstep interpolant, matching the original procedural noise

    // mod() on the cell index (and on index+1) is the entire trick: the cell one past the end of the
    // period is the cell at the start, so opposite faces of the volume interpolate into each other.
    vec3 i0 = mod(i, period);
    vec3 i1 = mod(i + 1.0, period);

    float n000 = hashCell(vec3(i0.x, i0.y, i0.z));
    float n100 = hashCell(vec3(i1.x, i0.y, i0.z));
    float n010 = hashCell(vec3(i0.x, i1.y, i0.z));
    float n110 = hashCell(vec3(i1.x, i1.y, i0.z));
    float n001 = hashCell(vec3(i0.x, i0.y, i1.z));
    float n101 = hashCell(vec3(i1.x, i0.y, i1.z));
    float n011 = hashCell(vec3(i0.x, i1.y, i1.z));
    float n111 = hashCell(vec3(i1.x, i1.y, i1.z));

    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
}

// Tileable FBM. Frequency doubles per octave and so does the period, which keeps every octave
// periodic over the SAME volume — the reason the octave scale here is exactly 2.0 rather than the
// 2.02/2.03 the procedural version used to break up lattice alignment.
float fbmTiled(vec3 p, float period, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    float per = period;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        sum += amp * valueNoiseTiled(p * (per / period), per);
        norm += amp;
        per *= 2.0;
        amp *= 0.5;
    }
    return sum / max(norm, 1e-5);
}

void main() {
    // Position in lattice space: [0,1] across the volume scaled to `u_period` cells.
    vec3 p = vec3(fragTexCoord, u_slice) * u_period;

    if (u_detail) {
        // Detail volume: three progressively finer erosion bands. Only RGB is used.
        outColor = vec4(
            fbmTiled(p, u_period, 3),
            fbmTiled(p * 2.0, u_period * 2.0, 3),
            fbmTiled(p * 4.0, u_period * 4.0, 2),
            1.0);
        return;
    }

    // Base volume:
    //   R = the low-frequency shape field  (stands in for the old 4-octave fbm)
    //   G = a medium band                  (stands in for the old 3-octave fbm3)
    //   B = a finer band                   (extra erosion / variety)
    //   A = a single octave                (stands in for the hash33 curl warp source)
    outColor = vec4(
        fbmTiled(p, u_period, u_octaves),
        fbmTiled(p * 2.0, u_period * 2.0, 3),
        fbmTiled(p * 4.0, u_period * 4.0, 3),
        valueNoiseTiled(p * 2.0, u_period * 2.0));
}
