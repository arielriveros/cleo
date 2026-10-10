// Particle billboards: one instance per pool slot, six vertices each, no vertex buffers at all.
//
// The vertex stage reads its particle straight out of the simulation's state textures by instance
// index (chunks/particleDraw.wgsl), expands the quad from the vertex index, and folds a dead slot to a
// degenerate point. That is the GPU-driven half of the design: the CPU never learns how many particles
// are alive, and does not need to.

#include "./chunks/particleDraw.wgsl"

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32,
           @builtin(instance_index) instanceIndex: u32) -> ParticleVaryings {
    let look = particleLook(instanceIndex);
    if (!look.alive) { return deadVaryings(); }
    var out: ParticleVaryings;

    // Two triangles: (0,1,2) (0,2,3) over the corners (-1,-1) (1,-1) (1,1) (-1,1).
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    let corner = corners[vertexIndex % 6u];
    let half = look.size * 0.5;

    let alignment = i32(u_draw.u_camPos.w);
    let toCam = u_draw.u_camPos.xyz - look.center;
    var right = u_draw.u_camRight.xyz;
    var up = u_draw.u_camUp.xyz;
    var normal = -u_draw.u_camForward.xyz;
    var offset: vec3<f32>;
    if (alignment == 1 && look.speed > 1e-4) {
        // Stretched along the motion, turned about it to face the camera as squarely as it can.
        let axis = look.velocity / look.speed;
        var side = cross(axis, toCam);
        if (dot(side, side) < 1e-10) { side = right; }
        side = normalize(side);
        let halfLength = half * (1.0 + look.speed * u_draw.u_camForward.w);
        offset = side * (corner.x * half) + axis * (corner.y * halfLength);
        normal = normalize(cross(side, axis));
    } else {
        if (alignment == 2) {
            up = vec3<f32>(0.0, 1.0, 0.0);
            var flatRight = vec3<f32>(right.x, 0.0, right.z);
            if (dot(flatRight, flatRight) < 1e-8) { flatRight = vec3<f32>(1.0, 0.0, 0.0); }
            right = normalize(flatRight);
            normal = cross(right, up);
        } else if (alignment == 3) {
            right = vec3<f32>(1.0, 0.0, 0.0);
            up = vec3<f32>(0.0, 0.0, -1.0);
            normal = vec3<f32>(0.0, 1.0, 0.0);
        }
        let c = cos(look.rotation);
        let s = sin(look.rotation);
        let rotated = vec2<f32>(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
        offset = (right * rotated.x + up * rotated.y) * half;
    }
    let world = look.center + offset;
    out.position = u_draw.u_viewProj * vec4<f32>(world, 1.0);
    out.viewDepth = dot(world - u_draw.u_camPos.xyz, u_draw.u_camForward.xyz);
    out.color = look.color;
    out.normal = normal;
    applyFlipbook(&out, look, corner * 0.5 + 0.5);
    return out;
}

@fragment
fn fs_main(in: ParticleVaryings) -> @location(0) vec4<f32> {
    return shadeParticle(in);
}
