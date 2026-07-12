#version 300 es

precision highp float;
#include "../screen/tonemap.glsl";

// Deferred geometry pass for terrain: blends up to 4 tiled material layers by an RGBA splat map, with
// optional automatic height/slope masking, height-aware blending, and per-pixel parallax. Each layer is
// a PBR surface (albedo + normal + scalar metallic/roughness) plus an optional displacement/height map
// that drives both the blend and the parallax. Outputs into the shared PBR G-buffer so the unified
// deferred lighting pass shades it. Paired with materials/default.vs (14-float layout).

in vec3 fragPos;
in vec2 fragTexCoord;
in vec4 fragPosLightSpace; // unused
in mat3 TBN;

layout(location = 0) out vec4 gAlbedoMetallic;   // rgb = albedo, a = metallic
layout(location = 1) out vec4 gNormalRoughness;  // rgb = world normal, a = roughness
layout(location = 2) out vec4 gEmissiveAO;       // rgb = emissive, a = ambient occlusion

uniform sampler2D u_splat;
uniform int u_layerCount;
uniform vec3 u_baseColor;
uniform vec3 u_viewPos; // camera world position (for the parallax view vector)

// Per-layer surface. Albedo/normal/displacement textures are sampled only when their u_hasXxxN flag is 1
// (a uniform, so the branch is uniform control flow — derivatives stay valid); otherwise the scalar/vector
// factors below are used. Metallic/roughness are scalar-only for terrain. u_colorN multiplies the albedo
// (it is the base color / diffuse for Basic/Blinn). u_dispN.r is the height in 0..1.
uniform sampler2D u_albedo0; uniform sampler2D u_albedo1; uniform sampler2D u_albedo2; uniform sampler2D u_albedo3;
uniform sampler2D u_normal0; uniform sampler2D u_normal1; uniform sampler2D u_normal2; uniform sampler2D u_normal3;
uniform sampler2D u_disp0; uniform sampler2D u_disp1; uniform sampler2D u_disp2; uniform sampler2D u_disp3;
uniform vec3 u_color0; uniform vec3 u_color1; uniform vec3 u_color2; uniform vec3 u_color3;
uniform float u_metallic0; uniform float u_metallic1; uniform float u_metallic2; uniform float u_metallic3;
uniform float u_roughness0; uniform float u_roughness1; uniform float u_roughness2; uniform float u_roughness3;
uniform int u_hasAlbedo0; uniform int u_hasAlbedo1; uniform int u_hasAlbedo2; uniform int u_hasAlbedo3;
uniform int u_hasNormal0; uniform int u_hasNormal1; uniform int u_hasNormal2; uniform int u_hasNormal3;
uniform int u_hasDisp0; uniform int u_hasDisp1; uniform int u_hasDisp2; uniform int u_hasDisp3;
uniform float u_tiling0; uniform float u_tiling1; uniform float u_tiling2; uniform float u_tiling3;
uniform float u_dispScale0; uniform float u_dispScale1; uniform float u_dispScale2; uniform float u_dispScale3;
uniform float u_heightBlend0; uniform float u_heightBlend1; uniform float u_heightBlend2; uniform float u_heightBlend3;

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

// Accumulate one layer's weighted PBR contribution at the (already parallax-offset) tiled uv. Texture
// sampling is guarded by the uniform u_hasXxx flags only (never by the per-fragment weight w) so mip
// derivatives stay well-defined.
void addLayer(
    float w, vec2 uv,
    sampler2D albedoTex, int hasAlbedo, vec3 color,
    sampler2D normalTex, int hasNormal, float metallic, float roughness,
    inout vec3 albedoAcc, inout float metallicAcc, inout float roughnessAcc, inout vec3 normalAcc
) {
    vec3 alb = toLinear(color); // sRGB layer tint -> linear
    if (hasAlbedo == 1) alb *= toLinear(texture(albedoTex, uv).rgb); // sRGB -> linear

    vec3 nrm = TBN[2];
    if (hasNormal == 1) {
        vec3 tn = texture(normalTex, uv).rgb * 2.0 - 1.0;
        nrm = normalize(TBN * tn);
    }

    albedoAcc    += w * alb;
    metallicAcc  += w * metallic;
    roughnessAcc += w * roughness;
    normalAcc    += w * nrm;
}

void main() {
    vec3 Ngeom = normalize(TBN[2]);
    float height = fragPos.y;
    float slope = clamp(1.0 - Ngeom.y, 0.0, 1.0);

    // Tangent-space view direction for parallax (TBN is orthonormal world<-tangent; transpose = world->tangent).
    // Offset-limited parallax: use Vt.xy directly (no 1/Vt.z), so the offset stays bounded and doesn't
    // swim at grazing angles.
    vec3 Vw = normalize(u_viewPos - fragPos);
    vec3 Vt = vec3(dot(Vw, TBN[0]), dot(Vw, TBN[1]), dot(Vw, TBN[2]));
    vec2 pdir = Vt.xy;

    // Base tiled uvs, per-layer height, and parallax-offset uvs.
    vec2 uv0 = fragTexCoord * u_tiling0;
    vec2 uv1 = fragTexCoord * u_tiling1;
    vec2 uv2 = fragTexCoord * u_tiling2;
    vec2 uv3 = fragTexCoord * u_tiling3;
    float h0 = (u_hasDisp0 == 1) ? texture(u_disp0, uv0).r : 0.0;
    float h1 = (u_hasDisp1 == 1) ? texture(u_disp1, uv1).r : 0.0;
    float h2 = (u_hasDisp2 == 1) ? texture(u_disp2, uv2).r : 0.0;
    float h3 = (u_hasDisp3 == 1) ? texture(u_disp3, uv3).r : 0.0;
    if (u_hasDisp0 == 1) uv0 -= pdir * (h0 * u_dispScale0);
    if (u_hasDisp1 == 1) uv1 -= pdir * (h1 * u_dispScale1);
    if (u_hasDisp2 == 1) uv2 -= pdir * (h2 * u_dispScale2);
    if (u_hasDisp3 == 1) uv3 -= pdir * (h3 * u_dispScale3);

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

    // Height-aware blend: bias each weight by its height (h=0 when no disp map -> factor 1, i.e. the
    // original linear blend). Higher u_heightBlend sharpens transitions so high spots poke through.
    w0 *= exp(u_heightBlend0 * h0);
    w1 *= exp(u_heightBlend1 * h1);
    w2 *= exp(u_heightBlend2 * h2);
    w3 *= exp(u_heightBlend3 * h3);

    float sum = w0 + w1 + w2 + w3;

    vec3 albedo; float metallic; float roughness; vec3 N;
    if (sum < 1e-4) {
        albedo = toLinear(u_baseColor); // sRGB -> linear
        metallic = 0.0;
        roughness = 0.9;
        N = Ngeom;
    } else {
        vec3 albedoAcc = vec3(0.0);
        float metallicAcc = 0.0, roughnessAcc = 0.0;
        vec3 normalAcc = vec3(0.0);
        addLayer(w0, uv0, u_albedo0, u_hasAlbedo0, u_color0, u_normal0, u_hasNormal0, u_metallic0, u_roughness0, albedoAcc, metallicAcc, roughnessAcc, normalAcc);
        addLayer(w1, uv1, u_albedo1, u_hasAlbedo1, u_color1, u_normal1, u_hasNormal1, u_metallic1, u_roughness1, albedoAcc, metallicAcc, roughnessAcc, normalAcc);
        addLayer(w2, uv2, u_albedo2, u_hasAlbedo2, u_color2, u_normal2, u_hasNormal2, u_metallic2, u_roughness2, albedoAcc, metallicAcc, roughnessAcc, normalAcc);
        addLayer(w3, uv3, u_albedo3, u_hasAlbedo3, u_color3, u_normal3, u_hasNormal3, u_metallic3, u_roughness3, albedoAcc, metallicAcc, roughnessAcc, normalAcc);
        albedo = albedoAcc / sum;
        metallic = metallicAcc / sum;
        roughness = roughnessAcc / sum;
        N = normalize(normalAcc);
    }

    gAlbedoMetallic  = vec4(albedo, metallic);
    gNormalRoughness = vec4(N, roughness);
    gEmissiveAO      = vec4(0.0, 0.0, 0.0, 1.0);
}
