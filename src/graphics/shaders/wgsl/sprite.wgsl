// Batched sprite program: many unlit sprites in one instanced draw (render/sprites2d.ts). The vertex stage
// takes each instance's record from the per-object table; the fragment stage is basicForward's shading
// with those per-instance values. Lit sprites draw through spriteLit.wgsl.

#include "./chunks/spriteVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/spriteForward.wgsl"
