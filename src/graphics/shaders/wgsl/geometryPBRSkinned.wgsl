// Deferred geometry pass for skinned PBR meshes. Same G-buffer output as geometryPBR.wgsl,
// reached through the linear-blend skinning vertex stage.

// Build-time variants (see programVariants.ts): the parallax march compiled in only for materials
// that use it.
// @variant flat CLEO_POM=0
// @variant pom CLEO_POM=1

#include "./chunks/skinnedVertex.wgsl"
#include "./chunks/pbrGBuffer.wgsl"
