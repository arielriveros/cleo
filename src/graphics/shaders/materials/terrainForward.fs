#version 300 es

#include "../constants.glsl";
precision highp float;
#include "../screen/tonemap.glsl";

// FORWARD-lit terrain. The main scene renders terrain through the deferred G-buffer (geometryTerrain.fs),
// but the light-probe capture is a forward pass with a single colour attachment, so it needs a shader that
// both blends the terrain layers AND lights them in one draw. This mirrors geometryTerrain.fs's splat/auto
// blend to derive albedo/metallic/roughness/normal, then applies the same PBR lighting as pbr.fs. Uses the
// default 14-float vertex layout (default.vs) — the same VAO the deferred terrain shader uses.

in vec3 fragPos;
in vec2 fragTexCoord;
in mat3 TBN;

layout(location = 0) out vec4 fragColor;

// --- Terrain splat/layer uniforms (identical set to geometryTerrain.fs, populated by _applyTerrainMaterial) -
uniform sampler2D u_splat;
uniform int u_layerCount;
uniform vec3 u_baseColor;
uniform vec3 u_viewPos; // camera world position (parallax view vector + specular V)

// u_normalN is packed: rgb = tangent-space normal, a = displacement height (see geometryTerrain.fs).
uniform sampler2D u_albedo0; uniform sampler2D u_albedo1; uniform sampler2D u_albedo2; uniform sampler2D u_albedo3;
uniform sampler2D u_normal0; uniform sampler2D u_normal1; uniform sampler2D u_normal2; uniform sampler2D u_normal3;
uniform vec3 u_color0; uniform vec3 u_color1; uniform vec3 u_color2; uniform vec3 u_color3;
uniform float u_metallic0; uniform float u_metallic1; uniform float u_metallic2; uniform float u_metallic3;
uniform float u_roughness0; uniform float u_roughness1; uniform float u_roughness2; uniform float u_roughness3;
uniform int u_hasAlbedo0; uniform int u_hasAlbedo1; uniform int u_hasAlbedo2; uniform int u_hasAlbedo3;
uniform int u_hasNormal0; uniform int u_hasNormal1; uniform int u_hasNormal2; uniform int u_hasNormal3;
uniform int u_hasDisp0; uniform int u_hasDisp1; uniform int u_hasDisp2; uniform int u_hasDisp3;
uniform float u_tiling0; uniform float u_tiling1; uniform float u_tiling2; uniform float u_tiling3;
uniform float u_dispScale0; uniform float u_dispScale1; uniform float u_dispScale2; uniform float u_dispScale3;
uniform float u_heightBlend0; uniform float u_heightBlend1; uniform float u_heightBlend2; uniform float u_heightBlend3;

uniform int u_useAuto;
uniform int u_auto0; uniform int u_auto1; uniform int u_auto2; uniform int u_auto3;
uniform vec2 u_hRange0; uniform vec2 u_hRange1; uniform vec2 u_hRange2; uniform vec2 u_hRange3;
uniform vec2 u_sRange0; uniform vec2 u_sRange1; uniform vec2 u_sRange2; uniform vec2 u_sRange3;

// --- Lighting uniforms (subset of pbr.fs, populated by _setLighting) -----------------------------------
// NOTE: intentionally NO shadow cascades / u_envMap here, so this shader does NOT include
// environment/shadows.glsl. The terrain layer samplers occupy texture units 0..8 (unit 6 = normal2,
// unit 7 = albedo3, ...), which would collide with the shared shadow unit (6) and the env cube (7) —
// and two sampler TYPES on one unit is a GLES draw error. This shader only runs during light-probe
// capture (the main pipeline draws terrain through terrainGeometry), and shadows are suppressed for
// captures anyway, so it costs nothing. If shadows are ever wanted here, drop u_normal3 (unit 8)
// rather than renumbering the shared reservation.
// (It was 0..12 before each layer's height moved into its normal map's alpha; the collision remains.)
uniform int u_numPointLights;
uniform int u_numSpotlights;

uniform struct DirectionalLight {
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
} u_dirLight;

struct PointLight {
    vec3 position;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float constant;
    float linear;
    float quadratic;
};

struct SpotLight {
    vec3 position;
    vec3 direction;
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    float constant;
    float linear;
    float quadratic;
    float cutOff;      // cosine of the inner half-angle
    float outerCutOff; // cosine of the outer half-angle (smaller than cutOff)
};

uniform PointLight u_pointLights[MAX_POINT_LIGHTS];
uniform SpotLight  u_spotlights[MAX_SPOTLIGHTS];

const float PI = 3.14159265359;

float band(vec2 range, float v, float edge) {
    float lo = smoothstep(range.x - edge, range.x + edge, v);
    float hi = 1.0 - smoothstep(range.y - edge, range.y + edge, v);
    return clamp(lo * hi, 0.0, 1.0);
}

void addLayer(
    float w, vec2 uv,
    sampler2D albedoTex, int hasAlbedo, vec3 color,
    sampler2D normalTex, int hasNormal, float metallic, float roughness,
    inout vec3 albedoAcc, inout float metallicAcc, inout float roughnessAcc, inout vec3 normalAcc
) {
    vec3 alb = toLinear(color);
    if (hasAlbedo == 1) alb *= toLinear(texture(albedoTex, uv).rgb);

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

float DistributionGGX(vec3 N, vec3 H, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH * NdotH;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    return a2 / (PI * denom * denom);
}

float GeometrySchlickGGX(float NdotV, float roughness) {
    float r = (roughness + 1.0);
    float k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    return GeometrySchlickGGX(max(dot(N, L), 0.0), roughness) * GeometrySchlickGGX(max(dot(N, V), 0.0), roughness);
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

void accumulateLight(vec3 N, vec3 V, vec3 albedo, float metallic, float roughness, vec3 lightDir, vec3 radiance, inout vec3 Lo) {
    vec3 H = normalize(V + lightDir);
    float NDF = DistributionGGX(N, H, roughness);
    float G   = GeometrySmith(N, V, lightDir, roughness);
    vec3  F   = fresnelSchlick(max(dot(H, V), 0.0), mix(vec3(0.04), albedo, metallic));

    vec3 specular = (NDF * G * F) / (4.0 * max(dot(N, V), 0.0) * max(dot(N, lightDir), 0.0) + 0.001);
    vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
    Lo += (kD * albedo / PI + specular) * radiance * max(dot(N, lightDir), 0.0);
}

void main() {
    // --- 1. Terrain layer blend (mirrors geometryTerrain.fs) ------------------------------------------
    vec3 Ngeom = normalize(TBN[2]);
    float height = fragPos.y;
    float slope = clamp(1.0 - Ngeom.y, 0.0, 1.0);

    vec3 Vw = normalize(u_viewPos - fragPos);
    vec3 Vt = vec3(dot(Vw, TBN[0]), dot(Vw, TBN[1]), dot(Vw, TBN[2]));
    vec2 pdir = Vt.xy;

    vec2 uv0 = fragTexCoord * u_tiling0;
    vec2 uv1 = fragTexCoord * u_tiling1;
    vec2 uv2 = fragTexCoord * u_tiling2;
    vec2 uv3 = fragTexCoord * u_tiling3;
    // Height comes out of the normal map's alpha, read at the UN-offset uv (it is what produces the offset).
    float h0 = (u_hasDisp0 == 1) ? texture(u_normal0, uv0).a : 0.0;
    float h1 = (u_hasDisp1 == 1) ? texture(u_normal1, uv1).a : 0.0;
    float h2 = (u_hasDisp2 == 1) ? texture(u_normal2, uv2).a : 0.0;
    float h3 = (u_hasDisp3 == 1) ? texture(u_normal3, uv3).a : 0.0;
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

    w0 *= exp(u_heightBlend0 * h0);
    w1 *= exp(u_heightBlend1 * h1);
    w2 *= exp(u_heightBlend2 * h2);
    w3 *= exp(u_heightBlend3 * h3);

    float sum = w0 + w1 + w2 + w3;

    vec3 albedo; float metallic; float roughness; vec3 N;
    if (sum < 1e-4) {
        albedo = toLinear(u_baseColor);
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

    // --- 2. PBR forward lighting (subset of pbr.fs; no shadow/IBL — see uniform note above) -----------
    vec3 V = normalize(u_viewPos - fragPos);

    vec3 ambient = u_dirLight.ambient * albedo;

    vec3 Lo = vec3(0.0);
    if (dot(u_dirLight.direction, u_dirLight.direction) > 1e-6) {
        vec3 Ld = normalize(-u_dirLight.direction);
        accumulateLight(N, V, albedo, metallic, roughness, Ld, u_dirLight.diffuse, Lo);
    }

    for (int i = 0; i < u_numPointLights; i++) {
        vec3 L = normalize(u_pointLights[i].position - fragPos);
        float dist = length(u_pointLights[i].position - fragPos);
        float att = 1.0 / (u_pointLights[i].constant + u_pointLights[i].linear * dist + u_pointLights[i].quadratic * dist * dist);
        accumulateLight(N, V, albedo, metallic, roughness, L, u_pointLights[i].diffuse * att, Lo);
    }

    for (int i = 0; i < u_numSpotlights; i++) {
        vec3 L = normalize(u_spotlights[i].position - fragPos);
        float dist = length(u_spotlights[i].position - fragPos);
        float att = 1.0 / (u_spotlights[i].constant + u_spotlights[i].linear * dist + u_spotlights[i].quadratic * dist * dist);
        float theta = dot(L, normalize(-u_spotlights[i].direction));
        // cutOff/outerCutOff are COSINES of the half-angles (see Renderer's spot upload), so the
        // inner one is the LARGER value and the falloff denominator is inner - outer.
        float epsilon = u_spotlights[i].cutOff - u_spotlights[i].outerCutOff;
        float intensity = clamp((theta - u_spotlights[i].outerCutOff) / epsilon, 0.0, 1.0);
        accumulateLight(N, V, albedo, metallic, roughness, L, u_spotlights[i].diffuse * att * intensity, Lo);
    }

    // Output stays LINEAR HDR — the probe capture bakes it, and IBL/present tonemap later.
    fragColor = vec4(ambient + Lo, 1.0);
}
