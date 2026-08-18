#version 300 es

precision highp float;
#include "./tonemap.glsl";

// Fullscreen debug visualizer: displays one renderer buffer (G-buffer channel, SSAO, depth,
// shadow map, bloom, lit scene …) chosen by u_mode. Used only by the editor's Renderer mode;
// published builds always use the plain 'screen' shader.
uniform sampler2D u_screenTexture;
uniform int u_mode;
uniform float u_exposure; // for the tonemapped (linear-HDR) channels

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
    } else if (u_mode == 5) {
        // Motion-blur velocity (screen-space, small UV units in .rg). Amplify + bias so it's visible.
        outColor = vec4(t.rg * 15.0 + 0.5, 0.5, 1.0);
    } else if (u_mode == 6) {
        // Linear-HDR channels (lit scene, bloom): resolve to display so the preview matches the image.
        outColor = vec4(tonemap(t.rgb, u_exposure), 1.0);
    } else if (u_mode == 7) {
        // OVERDRAW heat map. The overdraw pass accumulates OVERDRAW_INCREMENT per fragment with
        // additive blending, so .r is (fragments shaded at this pixel) / OVERDRAW_MAX. Ramped
        // black -> blue -> green -> yellow -> red, which is the convention every GPU profiler uses,
        // so the reading transfers.
        //
        // This is the view that makes a fill-rate problem legible: draw-call and triangle counts say
        // nothing about how many times each pixel was shaded, and on a deferred renderer with a lot
        // of alpha-blended overlays that number is exactly what costs the frame.
        float n = clamp(t.r, 0.0, 1.0);
        vec3 heat;
        if (n < 0.25)      heat = mix(vec3(0.0, 0.0, 0.0), vec3(0.0, 0.2, 1.0), n / 0.25);
        else if (n < 0.5)  heat = mix(vec3(0.0, 0.2, 1.0), vec3(0.0, 1.0, 0.3), (n - 0.25) / 0.25);
        else if (n < 0.75) heat = mix(vec3(0.0, 1.0, 0.3), vec3(1.0, 1.0, 0.0), (n - 0.5) / 0.25);
        else               heat = mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), (n - 0.75) / 0.25);
        outColor = vec4(heat, 1.0);
    } else {
        // Passthrough RGB (albedo, emissive, …).
        outColor = vec4(t.rgb, 1.0);
    }
}
