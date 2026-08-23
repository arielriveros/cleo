// Forward PBR material.
// Same shading as deferredLighting.wgsl, computed per object from interpolated varyings.

#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/pbrForward.wgsl"
