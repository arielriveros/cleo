// Deferred geometry pass for PBR (metallic-roughness) materials, per-object model matrix.
// Writes surface parameters into the G-buffer; lighting happens later in deferredLighting.fs.

// Build-time variants (see programVariants.ts): the parallax march compiled in only for materials
// that use it.
// @variant flat CLEO_POM=0
// @variant pom CLEO_POM=1
// No `discard` at all, for an opaque material drawn with no dissolve: keeps early-Z (pbrGBuffer.wgsl).
// @variant opaque CLEO_POM=0 CLEO_OPAQUE=1

#include "./chunks/modelVertex.wgsl"
#include "./chunks/pbrGBuffer.wgsl"
