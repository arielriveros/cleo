#version 300 es

in vec3 a_position;

out vec3 fragTexCoord;

uniform mat4 u_view;
uniform mat4 u_projection;

void main() {
    fragTexCoord = a_position;
    mat4 positionCorrectedView = u_view;
    positionCorrectedView[3][0] = 0.0;
    positionCorrectedView[3][1] = 0.0;
    positionCorrectedView[3][2] = 0.0;

    vec4 pos = u_projection * positionCorrectedView * vec4(a_position, 1.0);

    gl_Position = pos.xyww;
}