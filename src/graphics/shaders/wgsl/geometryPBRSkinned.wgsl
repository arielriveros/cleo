// Deferred geometry pass for skinned PBR meshes. Same G-buffer output as geometryPBR.wgsl,
// reached through the linear-blend skinning vertex stage.

#include "./chunks/skinnedVertex.wgsl"
#include "./chunks/pbrGBuffer.wgsl"
