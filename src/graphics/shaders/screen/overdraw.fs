#version 300 es

precision highp float;

// Overdraw counter. Every fragment that survives to this shader contributes a fixed increment, which
// the renderer accumulates with additive blending (GL_ONE/GL_ONE) and no depth test, so the red
// channel ends up holding (fragments shaded here) / OVERDRAW_MAX. debugView.fs mode 7 ramps that to a
// heat map.
//
// Depth testing is deliberately OFF: the point is to count every fragment the rasterizer produced,
// including the ones a depth test would later reject — those still cost the shading that overdraw is
// meant to expose.

uniform float u_increment;

layout(location = 0) out vec4 outColor;

void main() {
    outColor = vec4(u_increment, 0.0, 0.0, 1.0);
}
