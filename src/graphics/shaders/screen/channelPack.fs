#version 300 es
precision highp float;

// Combines up to four source textures into one RGBA texture, taking one source channel per destination
// channel. Run by systems/texturePacker.ts as a single fullscreen quad into an FBO, ONCE per unique pack
// spec — never per frame. The point is what happens afterwards: the material shaders do one texture
// fetch where they used to do two or three, and bind one texture unit where they used to bind two.
//
// The pass is a straight byte copy per channel: no colour-space conversion, no filtering beyond the
// resample when sources differ in size. sRGB data stays sRGB, and the packer's UVs are the identity, so
// whatever orientation the sources were uploaded with is preserved.

in vec2 fragTexCoord;

layout(location = 0) out vec4 fragColor;

// The packer dedupes sources, so a spec whose channels all come from one image binds one texture here
// and the unused samplers alias it. Four is the ceiling: RGBA can't take more.
uniform sampler2D u_src0;
uniform sampler2D u_src1;
uniform sampler2D u_src2;
uniform sampler2D u_src3;

// Per destination channel (x=r, y=g, z=b, w=a): which of u_src0..3 to read from, or -1 to write the
// matching component of u_const instead. Uniform, so every branch below is uniform control flow.
uniform ivec4 u_srcIndex;
// Per destination channel: which component (0=r, 1=g, 2=b, 3=a) of that source to take.
uniform ivec4 u_srcChannel;
// Per destination channel: the value to write when u_srcIndex is -1.
uniform vec4 u_const;

// Samplers can't be indexed dynamically in GLSL ES 3.00, hence the chain rather than an array.
vec4 fetch(int index) {
    if (index == 0) return texture(u_src0, fragTexCoord);
    if (index == 1) return texture(u_src1, fragTexCoord);
    if (index == 2) return texture(u_src2, fragTexCoord);
    return texture(u_src3, fragTexCoord);
}

float channelOf(vec4 c, int channel) {
    if (channel == 0) return c.r;
    if (channel == 1) return c.g;
    if (channel == 2) return c.b;
    return c.a;
}

float resolve(int index, int channel, float fallback) {
    if (index < 0) return fallback;
    return channelOf(fetch(index), channel);
}

void main() {
    fragColor = vec4(
        resolve(u_srcIndex.x, u_srcChannel.x, u_const.x),
        resolve(u_srcIndex.y, u_srcChannel.y, u_const.y),
        resolve(u_srcIndex.z, u_srcChannel.z, u_const.z),
        resolve(u_srcIndex.w, u_srcChannel.w, u_const.w)
    );
}
