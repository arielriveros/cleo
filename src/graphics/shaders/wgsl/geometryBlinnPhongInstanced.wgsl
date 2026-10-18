// Deferred geometry pass for Blinn-Phong materials, instanced.

// Build-time variant: the foliage wind (chunks/foliageWind.wgsl) compiled in.
// @variant wind CLEO_WIND=1

#include "./chunks/instancedVertex.wgsl"
#include "./chunks/blinnPhongGBuffer.wgsl"
