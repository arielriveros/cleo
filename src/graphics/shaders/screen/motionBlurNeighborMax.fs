#version 300 es

precision highp float;

in vec2 fragTexCoord;

uniform sampler2D u_tileMax;       // tile-res TileMax velocities
uniform vec2 u_tileTexelSize;      // 1 / tile-res dimensions

out vec4 outColor;

// Dilate the dominant velocity across the 3x3 tile neighborhood so a fast object's blur bleeds
// into adjacent tiles instead of hard-clipping at its silhouette (UE5 NeighborMax).
void main() {
    vec2 maxVel = vec2(0.0);
    float maxLen = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 uv = fragTexCoord + vec2(float(x), float(y)) * u_tileTexelSize;
            vec2 v = texture(u_tileMax, uv).xy;
            float l = dot(v, v);
            if (l > maxLen) { maxLen = l; maxVel = v; }
        }
    }
    outColor = vec4(maxVel, 0.0, 1.0);
}
