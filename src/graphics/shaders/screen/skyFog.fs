#version 300 es

// Atmospheric distance fog for the SkyAtmosphere node (aerial perspective). A single fullscreen pass
// (on screen.vs): for each opaque pixel we reconstruct world position from depth, derive a fog factor
// from distance (+ optional height falloff), and take the fog COLOR by sampling the already-baked
// atmosphere cubemap in that pixel's view direction — so geometry fades into exactly the sky colour
// behind it. Output is straight-alpha (blended with SRC_ALPHA, ONE_MINUS_SRC_ALPHA) so it just tints
// the scene toward the fog colour; the sky (depth == 1.0) is skipped since it already IS that colour.

precision highp float;

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

uniform sampler2D u_gDepth;      // scene depth (opaque). Background == 1.0.
uniform mat4  u_invViewProj;
uniform vec3  u_viewPos;
uniform samplerCube u_atmosphere; // baked sky cubemap (display-referred), sampled for the fog colour

uniform float u_fogDensity;
uniform float u_fogStart;
uniform float u_fogHeight;
uniform float u_fogHeightFalloff;
uniform float u_fogMaxOpacity;
uniform vec3  u_fogColor;
uniform float u_fogColorBlend;   // 0 = pure atmosphere colour, 1 = pure custom colour
uniform float u_fogSkyLod;       // mip to sample the atmosphere at: blurs out the sharp sun disk so fog
                                 // reads as colour haze rather than a crisp window to the sky

vec3 reconstructWorldPos(float depth) {
    vec4 clip = vec4(fragTexCoord * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}

void main() {
    float depth = texture(u_gDepth, fragTexCoord).r;
    if (depth >= 1.0) discard;                 // sky: already the atmosphere colour, don't fog it

    vec3 worldPos = reconstructWorldPos(depth);
    vec3 toPixel = worldPos - u_viewPos;
    float dist = length(toPixel);
    vec3 viewDir = toPixel / max(dist, 1e-5);

    // Fog colour = atmosphere in this view direction (sampled from a blurred mip so the sharp sun disk
    // doesn't show "through" objects), optionally tinted toward a custom colour.
    vec3 atmoColor = textureLod(u_atmosphere, viewDir, u_fogSkyLod).rgb;
    vec3 fogColor = mix(atmoColor, u_fogColor, u_fogColorBlend);

    // Exponential distance fog beyond the start distance.
    float d = max(0.0, dist - u_fogStart);
    float distFog = 1.0 - exp(-d * u_fogDensity);

    // Optional height falloff: thinner with altitude above u_fogHeight (0 falloff = uniform fog).
    float heightFactor = 1.0;
    if (u_fogHeightFalloff > 0.0)
        heightFactor = clamp(exp(-max(0.0, worldPos.y - u_fogHeight) * u_fogHeightFalloff), 0.0, 1.0);

    float f = clamp(distFog * heightFactor, 0.0, u_fogMaxOpacity);
    if (f <= 0.0) discard;

    fragColor = vec4(fogColor, f);
}
