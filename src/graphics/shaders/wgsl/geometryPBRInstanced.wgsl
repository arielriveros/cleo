// Deferred geometry pass for instanced PBR meshes (foliage). Same G-buffer output as
// geometryPBR.wgsl, with the world matrix arriving per instance instead of as a uniform.

// Build-time variants (see programVariants.ts): the parallax march compiled in only for materials
// that use it.
// @variant flat CLEO_POM=0
// @variant pom CLEO_POM=1

#include "./chunks/instancedVertex.wgsl"
#include "./chunks/pbrGBuffer.wgsl"
