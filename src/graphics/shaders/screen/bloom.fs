#version 300 es

precision highp float;

// HDR bright-pass. Runs in scene-linear HDR (before the tonemapper), so the threshold is a real
// luminance cutoff — not a post-tonemap gamma-space hack. A soft knee ramps pixels in around the
// threshold instead of a hard per-channel clip, which avoids flickering/popping on small highlights.

uniform sampler2D u_screenTexture; // post-processed scene colour (may be motion-blurred)
uniform sampler2D u_bloomMask;     // raw scene buffer; its alpha flags bloom-eligible lit surfaces
uniform float u_bloomThreshold;    // luminance where bloom starts
uniform float u_bloomKnee;         // soft-knee width around the threshold (0 = hard cutoff)

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;   // scene passthrough (kept for the composite step)
layout(location = 1) out vec4 brightColor; // extracted bright part

void main() {
    vec3 color = texture(u_screenTexture, fragTexCoord).rgb;
    fragColor = vec4(color, 1.0);

    // Only lit PBR-model / Blinn-Phong surfaces feed bloom. The scene buffer's alpha is 1 on those and
    // 0 on sky / unlit "basic" / clouds / sprites / grid / gizmos, so gate the bright-pass on it.
    float mask = step(0.5, texture(u_bloomMask, fragTexCoord).a);

    // Perceptual luminance of the linear-HDR colour.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));

    // Soft-knee curve (Unreal/Unity style): 0 below (threshold - knee), smooth ramp across the knee,
    // then linear (luma - threshold) above. Scaling the colour by contribution/luma keeps its hue.
    float knee = max(u_bloomKnee, 1e-4);
    float soft = clamp(luma - (u_bloomThreshold - knee), 0.0, 2.0 * knee);
    soft = (soft * soft) / (4.0 * knee + 1e-5);
    float contribution = max(soft, luma - u_bloomThreshold) / max(luma, 1e-5);

    brightColor = vec4(color * contribution * mask, 1.0);
}
