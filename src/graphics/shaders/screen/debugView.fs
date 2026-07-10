#version 300 es

precision highp float;

// Fullscreen debug visualizer: displays one renderer buffer (G-buffer channel, SSAO, depth,
// shadow map, bloom, lit scene …) chosen by u_mode. Used only by the editor's Renderer mode;
// published builds always use the plain 'screen' shader.
uniform sampler2D u_screenTexture;
uniform int u_mode;

in vec2 fragTexCoord;

out vec4 outColor;

void main() {
    vec4 t = texture(u_screenTexture, fragTexCoord);

    if (u_mode == 1) {
        // World-space normals stored in [-1,1] -> remap to viewable [0,1] color.
        outColor = vec4(t.rgb * 0.5 + 0.5, 1.0);
    } else if (u_mode == 2) {
        // Scalar packed in the alpha channel (metallic / roughness / ambient occlusion).
        outColor = vec4(vec3(t.a), 1.0);
    } else if (u_mode == 3) {
        // Non-linear depth in .r; a contrast curve spreads the far-weighted range so structure shows.
        outColor = vec4(vec3(pow(t.r, 40.0)), 1.0);
    } else if (u_mode == 4) {
        // Single-channel value in .r (SSAO occlusion factor).
        outColor = vec4(vec3(t.r), 1.0);
    } else {
        // Passthrough RGB (albedo, emissive, lit scene, bloom).
        outColor = vec4(t.rgb, 1.0);
    }
}
