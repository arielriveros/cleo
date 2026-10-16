// Forward PBR material.
// Same shading as deferredLighting.wgsl, computed per object from interpolated varyings.

// Build-time variants (see programVariants.ts): one shadow filter each, chosen by the render setting,
// with the parallax march compiled in only for materials that use it (the `.pom` pair).
// @variant pcf CLEO_SHADOW_FILTER=0 CLEO_POM=0
// @variant poisson CLEO_SHADOW_FILTER=1 CLEO_POM=0
// @variant pcf.pom CLEO_SHADOW_FILTER=0 CLEO_POM=1
// @variant poisson.pom CLEO_SHADOW_FILTER=1 CLEO_POM=1

#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"
#include "./chunks/pbrForward.wgsl"
