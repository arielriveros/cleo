// Deferred geometry pass for Blinn-Phong materials, instanced.

// No foliage variant: foliage is a PBR material (Material.Foliage), so a Blinn-Phong layer never sways.

#include "./chunks/instancedVertex.wgsl"
#include "./chunks/blinnPhongGBuffer.wgsl"
