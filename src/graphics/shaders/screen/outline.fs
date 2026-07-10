#version 300 es
precision highp float;

in vec2 fragTexCoord;

uniform sampler2D u_screenTexture; // composited scene color
uniform sampler2D u_maskTexture;   // selection silhouette (white = selected)
uniform vec2 u_texelSize;          // 1.0 / mask resolution
uniform vec3 u_outlineColor;
uniform float u_outlineWidth;      // outline thickness, in pixels

out vec4 outColor;

// Screen-space selection outline. Draws a thick, anti-aliased border just OUTSIDE the selected
// silhouette, plus a soft glow halo, so selection reads as a pronounced highlight without
// repainting the object itself. Works by measuring the distance (in pixels) from each background
// pixel to the nearest silhouette texel within a search radius.
void main() {
    vec3 scene = texture(u_screenTexture, fragTexCoord).rgb;
    float center = texture(u_maskTexture, fragTexCoord).r;
    if (center > 0.5) { outColor = vec4(scene, 1.0); return; } // inside the object: leave untouched

    const int R = 10; // search radius in texels; bounds the maximum outline width
    float best = 1e9;
    for (int y = -R; y <= R; y++) {
        for (int x = -R; x <= R; x++) {
            float d2 = float(x * x + y * y);
            if (d2 > float(R * R) || d2 == 0.0) continue;
            vec2 uv = fragTexCoord + vec2(float(x), float(y)) * u_texelSize;
            if (texture(u_maskTexture, uv).r > 0.5) best = min(best, d2);
        }
    }

    float dist = sqrt(best);                  // pixels to the nearest silhouette edge
    float w = u_outlineWidth;
    float glow = w * 1.25;                     // soft halo beyond the solid core

    // Solid, anti-aliased core out to `w`, then a faint falloff out to `w + glow`.
    float core = 1.0 - smoothstep(w - 1.0, w, dist);
    float halo = (1.0 - smoothstep(w, w + glow, dist)) * 0.4;
    float a = max(core, halo);

    outColor = vec4(mix(scene, u_outlineColor, a), 1.0);
}
