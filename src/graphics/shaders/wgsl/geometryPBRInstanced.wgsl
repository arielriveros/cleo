// Deferred geometry pass for instanced PBR meshes (foliage). Same G-buffer output as
// geometryPBR.wgsl, with the world matrix arriving per instance instead of as a uniform.

// Build-time variants (see programVariants.ts): the parallax march compiled in only for materials
// that use it.
// @variant flat CLEO_POM=0
// @variant pom CLEO_POM=1
// FOLIAGE materials (Material.Foliage) only: the wind, interaction and weather bend in the vertex stage,
// and variation, gusts and weather on the surface (chunks/foliageSurface.wgsl). Nothing else compiles them.
// @variant foliage CLEO_POM=0 CLEO_WIND=1 CLEO_FOLIAGE=1
// No `discard` at all: placed instanced copies of an opaque material (never foliage, which crossfades).
// @variant opaque CLEO_POM=0 CLEO_OPAQUE=1
// Foliage that maps by its mesh uv: no projection charts, no parallax frame, no specular AA (pbrGBuffer).
// @variant lean CLEO_POM=0 CLEO_LEAN=1
// @variant leanFoliage CLEO_POM=0 CLEO_WIND=1 CLEO_FOLIAGE=1 CLEO_LEAN=1
// The foliage depth prepass (Renderer.foliagePrepass): the cutout decided, depth written, no colour; then
// the colour pass through `leanOpaque` (no discard: the prepass's depth, tested 'equal', does the cutting).
// @variant prepass CLEO_POM=0 CLEO_LEAN=1 CLEO_PREPASS=1
// @variant prepassFoliage CLEO_POM=0 CLEO_WIND=1 CLEO_FOLIAGE=1 CLEO_LEAN=1 CLEO_PREPASS=1
// @variant leanOpaque CLEO_POM=0 CLEO_LEAN=1 CLEO_OPAQUE=1
// @variant leanOpaqueFoliage CLEO_POM=0 CLEO_WIND=1 CLEO_FOLIAGE=1 CLEO_LEAN=1 CLEO_OPAQUE=1

// Every variant evaluates the weather volumes and the shelter map per plant (chunks/instancedVertex.wgsl).
#define CLEO_INSTANCED_WEATHER 1
#include "./chunks/instancedVertex.wgsl"
#include "./chunks/pbrGBuffer.wgsl"
