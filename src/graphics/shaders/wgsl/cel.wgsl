// Forward Cel (toon) material.
//
// chunks/pbrLighting.wgsl is included even though none of its BRDF is reachable: it owns the light
// structs, skyIrradiance and the shared attenuation curves that the cel chunk and clusteredLights both
// consume. naga strips the unreachable Cook-Torrance from the emitted GLSL, exactly as it does for
// blinnPhong.wgsl.

// Build-time variants (see programVariants.ts): one shadow filter each, chosen by the render setting.
// @variant pcf CLEO_SHADOW_FILTER=0
// @variant poisson CLEO_SHADOW_FILTER=1

#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"
#include "./chunks/celForward.wgsl"
