// Deferred geometry pass for instanced PBR meshes (foliage). Same G-buffer output as
// geometryPBR.wgsl, with the world matrix arriving per instance instead of as a uniform.

#include "./chunks/instancedVertex.wgsl"
#include "./chunks/pbrGBuffer.wgsl"
