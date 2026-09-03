// Forward Cel (toon) material, skinned.
//
// Same tail as cel.wgsl; only the vertex chunk differs. The skinned chunk puts bone indices and weights
// at locations 5 and 6, which is the LIT family's layout — that is what lets a cel mesh fall through the
// `basicFamily` tests in the shadow and object-velocity passes onto their default programs.

#include "./chunks/skinnedVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/shadows.wgsl"
#include "./chunks/pbrLighting.wgsl"
#include "./chunks/clusteredLights.wgsl"
#include "./chunks/celForward.wgsl"
