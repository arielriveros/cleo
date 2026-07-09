#version 300 es
precision highp float;

// Diffuse IBL: convolves the source environment cubemap into an irradiance map by integrating the
// cosine-weighted radiance over the hemisphere around each direction. Rendered per cube face.

in vec3 localPos;
layout(location = 0) out vec4 fragColor;

uniform samplerCube u_envMap;

const float PI = 3.14159265359;

void main() {
    vec3 N = normalize(localPos);

    vec3 irradiance = vec3(0.0);
    vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 right = normalize(cross(up, N));
    up = normalize(cross(N, right));

    float sampleDelta = 0.025;
    float nrSamples = 0.0;
    for (float phi = 0.0; phi < 2.0 * PI; phi += sampleDelta) {
        for (float theta = 0.0; theta < 0.5 * PI; theta += sampleDelta) {
            // Tangent-space sample -> world.
            vec3 tangentSample = vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
            vec3 sampleVec = tangentSample.x * right + tangentSample.y * up + tangentSample.z * N;
            irradiance += texture(u_envMap, sampleVec).rgb * cos(theta) * sin(theta);
            nrSamples++;
        }
    }
    irradiance = PI * irradiance * (1.0 / nrSamples);
    fragColor = vec4(irradiance, 1.0);
}
