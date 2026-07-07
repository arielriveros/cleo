#version 300 es
precision highp float;

// Deferred geometry pass for terrain: blends up to 4 tiled material layers by an RGBA splat map,
// with optional automatic height/slope masking per layer. Outputs into the shared PBR G-buffer so
// the unified deferred lighting pass shades it. Paired with materials/default.vs (14-float layout).

in vec3 fragPos;
in vec2 fragTexCoord;
in vec4 fragPosLightSpace; // unused
in mat3 TBN;

layout(location = 0) out vec4 gAlbedoMetallic;   // rgb = albedo, a = metallic
layout(location = 1) out vec4 gNormalRoughness;  // rgb = world normal, a = roughness
layout(location = 2) out vec4 gEmissiveAO;       // rgb = emissive, a = ambient occlusion

uniform sampler2D u_splat;
uniform sampler2D u_layer0;
uniform sampler2D u_layer1;
uniform sampler2D u_layer2;
uniform sampler2D u_layer3;
uniform float u_tiling0;
uniform float u_tiling1;
uniform float u_tiling2;
uniform float u_tiling3;
uniform int u_layerCount;
uniform vec3 u_baseColor;

// Automatic height/slope blending. u_useAuto enables it globally; u_autoN enables it per layer.
// u_hRangeN is a world-Y band, u_sRangeN is a slope band where slope = 1 - N.y (0 flat .. 1 vertical).
uniform int u_useAuto;
uniform int u_auto0; uniform int u_auto1; uniform int u_auto2; uniform int u_auto3;
uniform vec2 u_hRange0; uniform vec2 u_hRange1; uniform vec2 u_hRange2; uniform vec2 u_hRange3;
uniform vec2 u_sRange0; uniform vec2 u_sRange1; uniform vec2 u_sRange2; uniform vec2 u_sRange3;

float band(vec2 range, float v, float edge) {
    float lo = smoothstep(range.x - edge, range.x + edge, v);
    float hi = 1.0 - smoothstep(range.y - edge, range.y + edge, v);
    return clamp(lo * hi, 0.0, 1.0);
}

void main() {
    vec3 N = normalize(TBN[2]);
    float height = fragPos.y;
    float slope = clamp(1.0 - N.y, 0.0, 1.0);

    vec4 splat = texture(u_splat, fragTexCoord);
    float w0 = splat.r, w1 = splat.g, w2 = splat.b, w3 = splat.a;

    if (u_layerCount < 1) w0 = 0.0;
    if (u_layerCount < 2) w1 = 0.0;
    if (u_layerCount < 3) w2 = 0.0;
    if (u_layerCount < 4) w3 = 0.0;

    if (u_useAuto == 1) {
        if (u_auto0 == 1) w0 *= band(u_hRange0, height, 2.0) * band(u_sRange0, slope, 0.08);
        if (u_auto1 == 1) w1 *= band(u_hRange1, height, 2.0) * band(u_sRange1, slope, 0.08);
        if (u_auto2 == 1) w2 *= band(u_hRange2, height, 2.0) * band(u_sRange2, slope, 0.08);
        if (u_auto3 == 1) w3 *= band(u_hRange3, height, 2.0) * band(u_sRange3, slope, 0.08);
    }

    float sum = w0 + w1 + w2 + w3;
    vec3 albedo;
    if (sum < 1e-4) {
        albedo = u_baseColor;
    } else {
        vec3 c0 = texture(u_layer0, fragTexCoord * u_tiling0).rgb;
        vec3 c1 = texture(u_layer1, fragTexCoord * u_tiling1).rgb;
        vec3 c2 = texture(u_layer2, fragTexCoord * u_tiling2).rgb;
        vec3 c3 = texture(u_layer3, fragTexCoord * u_tiling3).rgb;
        albedo = (w0 * c0 + w1 * c1 + w2 * c2 + w3 * c3) / sum;
    }

    gAlbedoMetallic  = vec4(albedo, 0.0);
    gNormalRoughness = vec4(N, 0.9);
    gEmissiveAO      = vec4(0.0, 0.0, 0.0, 1.0);
}
