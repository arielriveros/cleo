// Deferred geometry pass for PBR (metallic-roughness) materials, per-object model matrix.
// Writes surface parameters into the G-buffer; lighting happens later in deferredLighting.fs.

#include "./chunks/modelVertex.wgsl"
#include "./chunks/pbrGBuffer.wgsl"
