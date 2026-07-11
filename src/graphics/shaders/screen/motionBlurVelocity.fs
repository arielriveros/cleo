#version 300 es

precision highp float;

in vec2 fragTexCoord;

uniform sampler2D u_gDepth;      // device depth from the G-buffer
uniform mat4 u_invViewProj;      // this frame's inverse view-projection
uniform mat4 u_prevViewProj;     // previous frame's view-projection
uniform float u_intensity;       // shutter-like blur scale
uniform vec2 u_screenSize;       // full-res dimensions (px)
uniform float u_maxVelocityPx;   // clamp blur length to this many pixels

out vec4 outColor;

// Reconstruct world position from device depth (same primitive the deferred lighting pass uses).
vec3 reconstructWorldPos(float depth) {
    vec4 clip = vec4(fragTexCoord * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 world = u_invViewProj * clip;
    return world.xyz / world.w;
}

void main() {
    // Reconstruct this pixel's world position. Background (no geometry, depth == 1.0) is treated
    // as a point on the far plane so the sky still blurs under camera rotation.
    float depth = min(texture(u_gDepth, fragTexCoord).r, 0.999999);
    vec3 worldPos = reconstructWorldPos(depth);

    // Where did this world point sit on screen last frame?
    vec4 prevClip = u_prevViewProj * vec4(worldPos, 1.0);
    vec2 prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

    // Screen-space motion vector in UV units.
    vec2 velocity = (fragTexCoord - prevUV) * u_intensity;

    // Clamp the blur length (measured in pixels) so streaks never exceed one tile.
    vec2 velPx = velocity * u_screenSize;
    float lenPx = length(velPx);
    if (lenPx > u_maxVelocityPx)
        velocity *= u_maxVelocityPx / max(lenPx, 1e-5);

    outColor = vec4(velocity, 0.0, 1.0);
}
