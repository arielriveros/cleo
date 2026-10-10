// Mesh particles: the particle's mesh instanced once per pool slot. Vertex buffer slot 0 is the mesh
// (position, normal, uv — src/particles/particleMesh.ts interleaves it); everything per-particle comes
// from the simulation's state textures by instance index, exactly as for billboards.
//
// Orientation: "velocity" alignment points the mesh's +Y along the motion; every other alignment tumbles
// it about a random axis fixed per particle (its seed), by the simulated rotation — debris and shards.

#include "./chunks/particleDraw.wgsl"

/** Rotate `v` about unit `axis` by `angle` (Rodrigues). */
fn rotateAbout(v: vec3<f32>, axis: vec3<f32>, angle: f32) -> vec3<f32> {
    let c = cos(angle);
    let s = sin(angle);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

@vertex
fn vs_main(@location(0) position: vec3<f32>,
           @location(1) normal: vec3<f32>,
           @location(2) texCoord: vec2<f32>,
           @builtin(instance_index) instanceIndex: u32) -> ParticleVaryings {
    let look = particleLook(instanceIndex);
    if (!look.alive) { return deadVaryings(); }
    var out: ParticleVaryings;

    var p = position * look.size;
    var n = normal;
    let alignment = i32(u_draw.u_camPos.w);
    if (alignment == 1 && look.speed > 1e-4) {
        // A basis with +Y along the velocity: the mesh flies nose first.
        let yAxis = look.velocity / look.speed;
        let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(yAxis.y) > 0.95);
        let xAxis = normalize(cross(helper, yAxis));
        let zAxis = cross(xAxis, yAxis);
        let stretch = 1.0 + look.speed * u_draw.u_camForward.w;
        p = xAxis * p.x + yAxis * (p.y * stretch) + zAxis * p.z;
        n = normalize(xAxis * n.x + yAxis * (n.y / stretch) + zAxis * n.z);
    } else {
        // A fixed random axis per particle, from its seed; the simulated rotation spins it.
        var rng = pcgHash(u32(look.seed * 16777216.0));
        let z = particleRand(&rng) * 2.0 - 1.0;
        let a = particleRand(&rng) * 6.28318530718;
        let r = sqrt(max(0.0, 1.0 - z * z));
        let axis = vec3<f32>(r * cos(a), z, r * sin(a));
        p = rotateAbout(p, axis, look.rotation);
        n = rotateAbout(n, axis, look.rotation);
    }

    let world = look.center + p;
    out.position = u_draw.u_viewProj * vec4<f32>(world, 1.0);
    out.viewDepth = dot(world - u_draw.u_camPos.xyz, u_draw.u_camForward.xyz);
    out.color = look.color;
    out.normal = n;
    applyFlipbook(&out, look, texCoord);
    return out;
}

@fragment
fn fs_main(in: ParticleVaryings) -> @location(0) vec4<f32> {
    return shadeParticle(in);
}
