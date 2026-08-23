// Forward PBR material, skinned.
// Same shading as deferredLighting.wgsl, computed per object from interpolated varyings.

#include "./chunks/skinnedVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/pbrForward.wgsl"
