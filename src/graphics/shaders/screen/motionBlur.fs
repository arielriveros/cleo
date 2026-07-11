#version 300 es

precision highp float;

// Upper bound for the dynamic sample loop (actual count comes from u_samples).
#define MAX_SAMPLES 32

in vec2 fragTexCoord;

uniform sampler2D u_screenTexture;  // lit scene color
uniform sampler2D u_velocity;       // full-res per-pixel velocity (UV units)
uniform sampler2D u_neighborMax;    // tile-res dominant (dilated) velocity (UV units)
uniform sampler2D u_gDepth;         // device depth
uniform vec2 u_texelSize;           // 1 / full-res dimensions
uniform vec2 u_screenSize;          // full-res dimensions (px)
uniform int u_samples;              // taps per pixel
uniform float u_near;
uniform float u_far;

out vec4 outColor;

// Soft depth-comparison extent, in linear (view-space) units.
const float SOFT_Z_EXTENT = 1.0;

float linearizeDepth(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * u_near * u_far) / (u_far + u_near - z * (u_far - u_near));
}

// Cheap per-pixel dither to break up banding between the discrete taps.
float interleavedGradientNoise(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// 1 when za is in front of zb (within the soft extent), 0 when clearly behind.
float softDepthCompare(float za, float zb) {
    return clamp(1.0 - (za - zb) / SOFT_Z_EXTENT, 0.0, 1.0);
}

// Falls off linearly as the tap distance approaches the velocity length.
float cone(float dist, float velLen) {
    return clamp(1.0 - dist / velLen, 0.0, 1.0);
}

// Near-flat contribution for taps well within a blurred sample's own trail.
float cylinder(float dist, float velLen) {
    return 1.0 - smoothstep(0.95 * velLen, 1.05 * velLen, dist);
}

// McGuire 2012 "A Reconstruction Filter for Plausible Motion Blur" (the basis of UE's filter).
void main() {
    vec2 uv = fragTexCoord;
    vec3 centerColor = texture(u_screenTexture, uv).rgb;

    // Dominant velocity for this tile (pixels). If nothing is moving, pass the pixel through.
    vec2 vN = texture(u_neighborMax, uv).xy;
    float vNlen = length(vN * u_screenSize);
    if (vNlen < 0.5) {
        outColor = vec4(centerColor, 1.0);
        return;
    }

    vec2 vC = texture(u_velocity, uv).xy;
    float vClen = max(length(vC * u_screenSize), 0.5);
    float centerDepth = linearizeDepth(texture(u_gDepth, uv).r);

    float jitter = interleavedGradientNoise(gl_FragCoord.xy) - 0.5;
    int samples = u_samples;

    // Weighted accumulation, seeded with the center tap.
    float weight = 1.0 / vClen;
    vec3 result = centerColor * weight;

    for (int i = 0; i < MAX_SAMPLES; i++) {
        if (i >= samples) break;

        // Symmetric, jittered position along the dominant velocity, skipping the exact center.
        float t = mix(-1.0, 1.0, (float(i) + jitter + 1.0) / (float(samples) + 1.0));
        vec2 sampleUV = uv + vN * t;

        vec2 vS = texture(u_velocity, sampleUV).xy;
        float vSlen = max(length(vS * u_screenSize), 0.5);
        float sampleDepth = linearizeDepth(texture(u_gDepth, sampleUV).r);

        float dist = abs(t) * vNlen;

        // linearizeDepth is positive-forward (larger = farther).
        float bg = softDepthCompare(centerDepth, sampleDepth); // 1 when center is closer -> sample is background
        float fg = softDepthCompare(sampleDepth, centerDepth); // 1 when sample is closer -> sample is foreground

        float alpha = fg * cone(dist, vSlen) +                // blurry foreground sample covers center
                      bg * cone(dist, vClen) +                // center's own blur reveals background sample
                      cylinder(dist, vSlen) * cylinder(dist, vClen) * 2.0; // both blurry, similar depth

        weight += alpha;
        result += texture(u_screenTexture, sampleUV).rgb * alpha;
    }

    outColor = vec4(result / weight, 1.0);
}
