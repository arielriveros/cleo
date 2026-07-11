#version 300 es

precision highp float;

in vec2 fragTexCoord;

uniform sampler2D u_velocity;   // full-res per-pixel velocity (UV units)
uniform vec2 u_texelSize;       // 1 / full-res dimensions
uniform int u_tileSize;         // tile edge in full-res pixels (K)

out vec4 outColor;

// Each output texel covers one KxK tile of the velocity buffer; keep the velocity with the
// largest magnitude in that tile (UE5 TileMax).
void main() {
    // Top-left full-res texel of this tile.
    vec2 tileOrigin = floor(gl_FragCoord.xy - 0.5) * float(u_tileSize);

    vec2 maxVel = vec2(0.0);
    float maxLen = 0.0;
    for (int y = 0; y < u_tileSize; y++) {
        for (int x = 0; x < u_tileSize; x++) {
            vec2 uv = (tileOrigin + vec2(float(x), float(y)) + 0.5) * u_texelSize;
            vec2 v = texture(u_velocity, uv).xy;
            float l = dot(v, v);
            if (l > maxLen) { maxLen = l; maxVel = v; }
        }
    }
    outColor = vec4(maxVel, 0.0, 1.0);
}
