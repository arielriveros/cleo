#version 300 es

precision highp float;

// Alpha-cutout depth shader for billboard foliage. Grass impostors are crossed quads whose shape
// lives entirely in the texture's alpha, so a plain depth-only pass would rasterize two solid
// rectangles and cast rectangular shadows. Mirrors the cutout in geometryFoliageBillboard.fs.

in vec2 fragTexCoord;
uniform sampler2D u_texture;

void main() {
    if (texture(u_texture, fragTexCoord).a < 0.5) discard;
}
