// Forward Blinn-Phong material.

// Build-time variants (see programVariants.ts): one shadow filter each, chosen by the render setting.
// @variant pcf CLEO_SHADOW_FILTER=0
// @variant poisson CLEO_SHADOW_FILTER=1

#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"
#include "./chunks/blinnPhongForward.wgsl"
