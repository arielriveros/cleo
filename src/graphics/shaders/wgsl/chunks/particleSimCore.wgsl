// THE particle simulation, shared by its two harnesses:
//   particleSimCompute.wgsl — a compute dispatch writing storage textures (WebGPU)
//   particleSim.wgsl        — a fullscreen draw into four colour targets (WebGL2, via naga)
// Both call `simulateSlot` for one slot and write what it returns. Nothing about the physics may live in
// a harness; that is what makes the two backends agree to float rounding rather than to intent.
//
// One step, per slot:
//   1. RESET: a cleared emitter kills everything.
//   2. SPAWN: a slot inside this step's ring window [spawnStart, spawnStart + spawnCount) is (re)born,
//      at a sub-step time so newborns spread along the step instead of stacking at its start.
//   3. UPDATE: forces -> semi-implicit Euler -> velocity limits -> collision -> spin. Dead slots skip it.
// A SUB-EMITTER spawns from its parent's events instead of a ring window: child slot j belongs to parent
// slot j / k, and is born when that parent dies or collides this step — read straight from the parent's
// state textures, so no event list, no readback, and the same code on both backends.
// Feature flags are bits of `u_mask.x`, set by src/particles/particlePack.ts. Every flag is a uniform
// branch — no permutations, one program for every emitter.

#include "./particleCommon.wgsl"
#include "./particleLut.wgsl"

const SIM_GRAVITY: u32        = 1u;
const SIM_DRAG: u32           = 2u;
const SIM_WIND: u32           = 4u;
const SIM_NOISE: u32          = 8u;
const SIM_VORTEX: u32         = 16u;
const SIM_ATTRACTOR: u32      = 32u;
const SIM_LIMIT: u32          = 64u;
const SIM_SPEED_LIFE: u32     = 128u;
const SIM_COLLIDE_DEPTH: u32  = 256u;
const SIM_COLLIDE_PLANES: u32 = 512u;
const SIM_SPIN_LIFE: u32      = 1024u;
const SIM_FIELDS: u32         = 2048u;
const SIM_LOCAL: u32          = 4096u;
const SIM_KILL_ON_HIT: u32    = 8192u;
const SIM_CUSTOM: u32         = 16384u;
const SIM_FLAT: u32           = 32768u;
const SIM_COLLIDE_BODIES: u32 = 65536u;

// Collider kinds in `u_colliders` — COLLIDER_KIND in src/particles/particleColliders.ts.
const COLLIDER_CAPSULE: i32 = 1;
const COLLIDER_BOX: i32 = 2;
const COLLIDER_PLANE: i32 = 3;
const MAX_PARTICLE_COLLIDERS: i32 = 12;

const MAX_PARTICLE_PLANES: i32 = 4;
const MAX_FORCE_FIELDS: i32 = 16;

struct ParticleSimUniforms {
    u_emitterPrev: mat4x4<f32>,       // emitter local -> world at the start of the step
    u_emitterCur: mat4x4<f32>,        // ... and at its end
    u_worldToSim: mat4x4<f32>,        // world -> simulation space (identity for world-space emitters)
    u_collideViewProj: mat4x4<f32>,   // LAST frame's unjittered view-projection, GL clip convention
    u_collideInvViewProj: mat4x4<f32>,
    u_step: vec4<f32>,                // dt, emitter time, capacity, texture width
    u_spawn: vec4<f32>,               // spawn start, spawn count, serial, seed
    u_mask: vec4<f32>,                // feature bits, reset, live window start, live window count
    u_shape0: vec4<f32>,              // shape kind, radius, volume (0 shell .. 1 solid), arc (rad)
    u_shape1: vec4<f32>,              // box half extents xyz, cone angle (rad)
    u_shapeOffset: vec4<f32>,         // offset xyz (emitter space), circle orbit (turns/s, 0 = off)
    u_life: vec4<f32>,                // lifetime min, max, size min, max
    u_speed: vec4<f32>,               // speed min, max, direction mode, inherit fraction
    u_dir: vec4<f32>,                 // direction xyz (emitter space), spread (rad)
    u_rot: vec4<f32>,                 // angle min, max, spin min, max (rad)
    u_colorA: vec4<f32>,
    u_colorB: vec4<f32>,
    u_colorMode: vec4<f32>,           // mode (0 constant, 1 between, 2 gradient), intensity, 0, 0
    u_emitterVel: vec4<f32>,          // emitter velocity (world), 0
    u_gravity: vec4<f32>,             // gravity (sim space), linear drag
    u_wind: vec4<f32>,                // wind velocity (sim space), coupling
    u_noise: vec4<f32>,               // strength, frequency, scroll, octaves
    u_vortex: vec4<f32>,              // axis (sim space, unit), strength
    u_vortexCenter: vec4<f32>,        // centre (sim space), pull
    u_attractor: vec4<f32>,           // position (sim space), strength
    u_attractor2: vec4<f32>,          // falloff radius, kill radius, 0, 0
    u_limit: vec4<f32>,               // max speed, dampen, 0, 0
    u_collide0: vec4<f32>,            // radius scale, restitution, friction, lifetime loss
    u_collide1: vec4<f32>,            // depth thickness, plane count, 0, 0
    u_collideScreen: vec4<f32>,       // depth width, height, flip y (1 on WebGPU), depth valid
    u_collideCam: vec4<f32>,          // last frame's camera position, orthographic
    u_planes: array<vec4<f32>, 4>,    // world: normal xyz, d  (n . p + d = 0)
    u_fieldInfo: vec4<f32>,           // field count, influence, 0, 0
    u_fields: array<vec4<f32>, 64>,   // 16 fields x 4 texels, see `forceFieldAccel`
    u_custom: vec4<f32>,
    u_sub: vec4<f32>,                 // sub-emitter: event (0 none, 1 death, 2 collision), children per event, inherit velocity, parent texture width
    u_sub2: vec4<f32>,                // parent capacity, 0, 0, 0
    u_colliderInfo: vec4<f32>,        // physics collider count, 0, 0, 0
    u_colliders: array<vec4<f32>, 48>,// 12 physics colliders x 4 texels, see `collideBodies`
};
@group(1) @binding(0) var<uniform> u_sim: ParticleSimUniforms;

@group(0) @binding(0) var u_p0_texture: texture_2d<f32>;
@group(0) @binding(1) var u_p1_texture: texture_2d<f32>;
@group(0) @binding(2) var u_p2_texture: texture_2d<f32>;
@group(0) @binding(3) var u_p3_texture: texture_2d<f32>;
@group(0) @binding(4) var u_lut_texture: texture_2d<f32>;
// The opaque scene depth of the PREVIOUS frame — this step runs before the current frame draws anything.
@group(0) @binding(5) var u_sceneDepth_texture: texture_depth_2d;
// Sampled at texel centres rather than loaded: naga cannot translate a depth `textureLoad` to GLSL.
@group(0) @binding(6) var u_sceneDepth_sampler: sampler;

// A sub-emitter's parent, after its step this frame (p*) and before it (prev*). Bound to the emitter's
// own textures when it has no parent — `u_sub.x` is 0 then and they are never read.
@group(0) @binding(7) var u_parentP0_texture: texture_2d<f32>;
@group(0) @binding(8) var u_parentP1_texture: texture_2d<f32>;
@group(0) @binding(9) var u_parentP2_texture: texture_2d<f32>;
@group(0) @binding(10) var u_parentPrevP0_texture: texture_2d<f32>;
@group(0) @binding(11) var u_parentPrevP1_texture: texture_2d<f32>;

// The collision flag a particle carries for ONE step, so a collision sub-emitter can see it: added to
// the seed (always in 0..1) and stripped at the start of the next step.
const HIT_FLAG: f32 = 2.0;

fn sceneDepthAt(texel: vec2<i32>) -> f32 {
    let uv = (vec2<f32>(texel) + 0.5) / u_sim.u_collideScreen.xy;
    return textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, uv, 0);
}

fn loadParticle(texel: vec2<i32>) -> Particle {
    let a = textureLoad(u_p0_texture, texel, 0);
    let b = textureLoad(u_p1_texture, texel, 0);
    let c = textureLoad(u_p2_texture, texel, 0);
    let d = textureLoad(u_p3_texture, texel, 0);
    var p: Particle;
    p.position = a.xyz; p.age = a.w;
    p.velocity = b.xyz; p.lifetime = b.w;
    p.rotation = c.x; p.spin = c.y; p.size = c.z; p.seed = c.w;
    p.color = d;
    return p;
}

// --- Spawn ---------------------------------------------------------------------------------------

fn randomUnitVector(rng: ptr<function, u32>) -> vec3<f32> {
    let z = particleRand(rng) * 2.0 - 1.0;
    let a = particleRand(rng) * 6.28318530718;
    let r = sqrt(max(0.0, 1.0 - z * z));
    return vec3<f32>(r * cos(a), z, r * sin(a));
}

// Tilt `dir` by a random angle up to `spread` radians, uniformly over the spherical cap.
fn spreadDirection(dir: vec3<f32>, spread: f32, rng: ptr<function, u32>) -> vec3<f32> {
    let u = particleRand(rng);
    let v = particleRand(rng);
    if (spread <= 0.0) { return dir; }
    let cosT = mix(1.0, cos(spread), u);
    let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
    let phi = v * 6.28318530718;
    let helper = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(dir.x) > 0.9);
    let t = normalize(cross(helper, dir));
    let b = cross(dir, t);
    return normalize(t * (cos(phi) * sinT) + b * (sin(phi) * sinT) + dir * cosT);
}

struct ShapeSample {
    position: vec3<f32>,
    normal: vec3<f32>,
};

// A point on (or in) the emission shape, and the direction "velocity from shape" uses there. Emitter
// space, +Y up; the volume parameter blends a surface (0) into a solid (1) by radius.
fn sampleShape(rng: ptr<function, u32>) -> ShapeSample {
    let kind = i32(u_sim.u_shape0.x);
    let radius = u_sim.u_shape0.y;
    let volume = clamp(u_sim.u_shape0.z, 0.0, 1.0);
    let arc = u_sim.u_shape0.w;
    var s: ShapeSample;
    s.position = vec3<f32>(0.0);
    s.normal = vec3<f32>(0.0, 1.0, 0.0);
    let r0 = particleRand(rng);
    let r1 = particleRand(rng);
    let r2 = particleRand(rng);

    if (kind == 1 || kind == 2) {              // sphere, hemisphere
        var d = randomUnitVector(rng);
        if (kind == 2) { d.y = abs(d.y); }
        s.normal = d;
        s.position = d * radius * mix(1.0, pow(r0, 1.0 / 3.0), volume);
    } else if (kind == 3) {                    // cone: a disc at the base, directions fanning out by angle
        let a = r0 * arc;
        let rho = mix(1.0, sqrt(r1), volume);
        let q = vec2<f32>(cos(a), sin(a)) * rho;
        s.position = vec3<f32>(q.x, 0.0, q.y) * radius;
        let t = tan(u_sim.u_shape1.w);
        s.normal = normalize(vec3<f32>(q.x * t, 1.0, q.y * t));
    } else if (kind == 4) {                    // box
        s.position = (vec3<f32>(r0, r1, r2) * 2.0 - 1.0) * u_sim.u_shape1.xyz;
    } else if (kind == 5) {                    // circle in the XZ plane, normals radial
        let a = r0 * arc;
        let dir = vec3<f32>(cos(a), 0.0, sin(a));
        s.position = dir * radius * mix(1.0, sqrt(r1), volume);
        s.normal = dir;
    } else if (kind == 6) {                    // edge along X
        s.position = vec3<f32>((r0 * 2.0 - 1.0) * radius, 0.0, 0.0);
    }
    s.position = s.position + u_sim.u_shapeOffset.xyz;
    return s;
}

fn transformPoint(m: mat4x4<f32>, p: vec3<f32>) -> vec3<f32> {
    return (m * vec4<f32>(p, 1.0)).xyz;
}

fn transformDir(m: mat4x4<f32>, d: vec3<f32>) -> vec3<f32> {
    return (m * vec4<f32>(d, 0.0)).xyz;
}

// `origin` (w = 1) replaces the emitter's position for a sub-emitter's event spawn; `inherited` is the
// velocity it carries over from the parent.
fn spawnParticle(slot: u32, spawnIndex: u32, seed: u32, origin: vec4<f32>, inherited: vec3<f32>) -> Particle {
    var rng = pcgHash(seed ^ pcgHash(u32(u_sim.u_spawn.w)));
    let isLocal = hasFeature(u_sim.u_mask.x, SIM_LOCAL) && origin.w < 0.5;

    // Where in the step this particle was born: 0 at its start, 1 at its end. The emitter matrix is
    // interpolated to that moment — the whole difference between a smooth trail behind a fast emitter
    // and a string of beads one frame apart.
    let birth = (f32(spawnIndex) + 0.5) / max(1.0, u_sim.u_spawn.y);
    var m = u_sim.u_emitterCur;
    let fromPos = u_sim.u_emitterPrev[3].xyz;
    let toPos = u_sim.u_emitterCur[3].xyz;
    m[3] = vec4<f32>(select(mix(fromPos, toPos, birth), origin.xyz, origin.w > 0.5), 1.0);

    let shape = sampleShape(&rng);
    var p: Particle;
    p.position = select(transformPoint(m, shape.position), shape.position, isLocal);

    // An ORBITING circle: the ring stands across the emitter's direction of travel and the spawn point
    // turns round it with time, so a moving emitter leaves a helix (a projectile's spiral trail). Its
    // radial direction is the shape's normal, already in world space.
    let orbit = u_sim.u_shapeOffset.w;
    let orbiting = i32(u_sim.u_shape0.x) == 5 && orbit != 0.0 && !isLocal;
    var orbitDir = vec3<f32>(0.0, 1.0, 0.0);
    if (orbiting) {
        let travel = u_sim.u_emitterVel.xyz;
        let axis = select(normalize(transformDir(m, vec3<f32>(0.0, 1.0, 0.0))), normalize(travel), dot(travel, travel) > 1e-6);
        let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(axis.y) > 0.9);
        let t = normalize(cross(axis, helper));
        let b = cross(axis, t);
        let when = u_sim.u_step.y - u_sim.u_step.x * (1.0 - birth);
        let a = 6.2831853 * orbit * when;
        orbitDir = t * cos(a) + b * sin(a);
        p.position = m[3].xyz + orbitDir * u_sim.u_shape0.y + transformDir(m, u_sim.u_shapeOffset.xyz);
    }

    let mode = i32(u_sim.u_speed.z);
    var dir = shape.normal;
    if (mode == 1) { dir = normalize(u_sim.u_dir.xyz + vec3<f32>(0.0, 1e-6, 0.0)); }
    if (mode == 2) {
        let radial = shape.position - u_sim.u_shapeOffset.xyz;
        dir = select(shape.normal, normalize(radial), dot(radial, radial) > 1e-8);
    }
    dir = spreadDirection(dir, u_sim.u_dir.w, &rng);
    if (!isLocal) { dir = normalize(transformDir(m, dir)); }
    if (orbiting && mode != 1) { dir = spreadDirection(orbitDir, u_sim.u_dir.w, &rng); }
    let speed = mix(u_sim.u_speed.x, u_sim.u_speed.y, particleRand(&rng));
    p.velocity = dir * speed;
    if (!isLocal) { p.velocity = p.velocity + u_sim.u_emitterVel.xyz * u_sim.u_speed.w; }
    p.velocity = p.velocity + inherited;

    p.lifetime = max(1e-3, mix(u_sim.u_life.x, u_sim.u_life.y, particleRand(&rng)));
    p.age = 0.0;
    p.size = mix(u_sim.u_life.z, u_sim.u_life.w, particleRand(&rng));
    p.rotation = mix(u_sim.u_rot.x, u_sim.u_rot.y, particleRand(&rng));
    p.spin = mix(u_sim.u_rot.z, u_sim.u_rot.w, particleRand(&rng));
    p.seed = particleRand(&rng);

    let colorMode = i32(u_sim.u_colorMode.x);
    var color = u_sim.u_colorA;
    if (colorMode == 1) { color = mix(u_sim.u_colorA, u_sim.u_colorB, particleRand(&rng)); }
    if (colorMode == 2) { color = particleLut(LUT_INIT_COLOR, particleRand(&rng)); }
    p.color = vec4<f32>(color.rgb * u_sim.u_colorMode.y, color.a);
    return p;
}

// --- Forces --------------------------------------------------------------------------------------

fn latticeGradient(c: vec3<f32>) -> vec3<f32> {
    let i = vec3<i32>(c);
    var h = pcgHash((u32(i.x) * 1597334677u) ^ (u32(i.y) * 3812015801u) ^ (u32(i.z) * 2798796415u));
    let x = f32(h >> 8u) / 16777216.0;
    h = pcgHash(h);
    let y = f32(h >> 8u) / 16777216.0;
    h = pcgHash(h);
    let z = f32(h >> 8u) / 16777216.0;
    return vec3<f32>(x, y, z) * 2.0 - 1.0;
}

// Classic gradient (Perlin) noise, roughly -1..1.
fn gradientNoise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let n000 = dot(latticeGradient(i + vec3<f32>(0.0, 0.0, 0.0)), f - vec3<f32>(0.0, 0.0, 0.0));
    let n100 = dot(latticeGradient(i + vec3<f32>(1.0, 0.0, 0.0)), f - vec3<f32>(1.0, 0.0, 0.0));
    let n010 = dot(latticeGradient(i + vec3<f32>(0.0, 1.0, 0.0)), f - vec3<f32>(0.0, 1.0, 0.0));
    let n110 = dot(latticeGradient(i + vec3<f32>(1.0, 1.0, 0.0)), f - vec3<f32>(1.0, 1.0, 0.0));
    let n001 = dot(latticeGradient(i + vec3<f32>(0.0, 0.0, 1.0)), f - vec3<f32>(0.0, 0.0, 1.0));
    let n101 = dot(latticeGradient(i + vec3<f32>(1.0, 0.0, 1.0)), f - vec3<f32>(1.0, 0.0, 1.0));
    let n011 = dot(latticeGradient(i + vec3<f32>(0.0, 1.0, 1.0)), f - vec3<f32>(0.0, 1.0, 1.0));
    let n111 = dot(latticeGradient(i + vec3<f32>(1.0, 1.0, 1.0)), f - vec3<f32>(1.0, 1.0, 1.0));
    let x00 = mix(n000, n100, u.x);
    let x10 = mix(n010, n110, u.x);
    let x01 = mix(n001, n101, u.x);
    let x11 = mix(n011, n111, u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

fn noisePotential(p: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(gradientNoise(p),
                     gradientNoise(p + vec3<f32>(31.416, -47.853, 12.793)),
                     gradientNoise(p + vec3<f32>(-91.734, 17.219, 63.481)));
}

// Curl of a vector noise potential (Bridson et al., "Curl-Noise for Procedural Fluid Flow"). Divergence
// free by construction, so particles swirl without bunching up into sinks or thinning out at sources.
fn curlNoise(p: vec3<f32>) -> vec3<f32> {
    let e = 0.1;
    let p0 = noisePotential(p);
    let px = noisePotential(p + vec3<f32>(e, 0.0, 0.0));
    let py = noisePotential(p + vec3<f32>(0.0, e, 0.0));
    let pz = noisePotential(p + vec3<f32>(0.0, 0.0, e));
    let dPdx = (px - p0) / e;
    let dPdy = (py - p0) / e;
    let dPdz = (pz - p0) / e;
    return vec3<f32>(dPdy.z - dPdz.y, dPdz.x - dPdx.z, dPdx.y - dPdy.x);
}

fn turbulence(p: vec3<f32>) -> vec3<f32> {
    let frequency = max(1e-3, u_sim.u_noise.y);
    let scroll = vec3<f32>(0.0, u_sim.u_noise.z * u_sim.u_step.y, 0.0);
    let octaves = i32(clamp(u_sim.u_noise.w, 1.0, 3.0));
    var total = vec3<f32>(0.0);
    var amplitude = 1.0;
    var f = frequency;
    for (var o = 0; o < 3; o++) {
        if (o >= octaves) { break; }
        total = total + curlNoise(p * f + scroll) * amplitude;
        amplitude = amplitude * 0.5;
        f = f * 2.0;
    }
    return total;
}

// Force-field record i, four texels: (position.xyz, kind) (direction.xyz, strength) (shape, radius,
// falloff, frequency) (box half extents.xyz, 0). World space. See ForceFieldNode.packInto.
fn forceFieldAccel(worldPos: vec3<f32>, worldVel: vec3<f32>) -> vec3<f32> {
    let count = i32(u_sim.u_fieldInfo.x);
    var total = vec3<f32>(0.0);
    for (var i = 0; i < MAX_FORCE_FIELDS; i++) {
        if (i >= count) { break; }
        let a = u_sim.u_fields[i * 4 + 0];
        let b = u_sim.u_fields[i * 4 + 1];
        let c = u_sim.u_fields[i * 4 + 2];
        let d = u_sim.u_fields[i * 4 + 3];
        let kind = i32(a.w);
        let shape = i32(c.x);
        let toP = worldPos - a.xyz;

        // Weight: 1 inside the shape's core, fading to 0 at its edge. Global fields weigh 1 everywhere.
        var w = 1.0;
        if (shape == 1) {
            let r = max(1e-4, c.y);
            let t = length(toP) / r;
            w = 1.0 - smoothstep(1.0 - clamp(c.z, 0.0, 1.0), 1.0, t);
        } else if (shape == 2) {
            let q = abs(toP) / max(d.xyz, vec3<f32>(1e-4));
            let t = max(q.x, max(q.y, q.z));
            w = 1.0 - smoothstep(1.0 - clamp(c.z, 0.0, 1.0), 1.0, t);
        }
        if (w <= 0.0) { continue; }
        let strength = b.w * w;

        if (kind == 0) {                       // directional / wind: pull velocity toward dir * strength
            total = total + (b.xyz * strength - worldVel);
        } else if (kind == 1) {                // radial: + attracts, - repels
            let dist = length(toP);
            if (dist > 1e-4) { total = total - toP / dist * strength; }
        } else if (kind == 2) {                // vortex about the axis through the field position
            let axis = normalize(b.xyz + vec3<f32>(0.0, 1e-6, 0.0));
            let radial = toP - axis * dot(toP, axis);
            let rl = length(radial);
            if (rl > 1e-4) { total = total + normalize(cross(axis, radial)) * strength; }
        } else if (kind == 3) {                // turbulence
            total = total + curlNoise(worldPos * max(1e-3, c.w)) * strength;
        } else if (kind == 4) {                // drag zone
            total = total - worldVel * strength;
        }
    }
    return total * u_sim.u_fieldInfo.y;
}

// --- Collision -----------------------------------------------------------------------------------

// Contact with a surface (`point`, unit `normal`, facing out) for a sphere of `radius`. WORLD space.
// Returned whole rather than written through pointers, so every path assigns every field.
struct Contact {
    hit: bool,
    position: vec3<f32>,
    velocity: vec3<f32>,
};

fn resolveContact(pos: vec3<f32>, vel: vec3<f32>, point: vec3<f32>, normal: vec3<f32>, radius: f32) -> Contact {
    var c: Contact;
    c.hit = false;
    c.position = pos;
    c.velocity = vel;
    let s = dot(pos - point, normal);
    if (s >= radius) { return c; }
    c.hit = true;
    c.position = pos + normal * (radius - s);
    let vn = dot(vel, normal);
    if (vn < 0.0) {
        let normalPart = normal * vn;
        let tangent = vel - normalPart;
        c.velocity = tangent * (1.0 - clamp(u_sim.u_collide0.z, 0.0, 1.0)) - normalPart * u_sim.u_collide0.y;
    }
    return c;
}

// A world point from a depth-texture texel, through last frame's inverse view-projection.
fn depthWorldPos(texel: vec2<i32>) -> vec3<f32> {
    let size = u_sim.u_collideScreen.xy;
    let t = clamp(texel, vec2<i32>(0), vec2<i32>(size) - 1);
    return depthWorldPosAt(t, sceneDepthAt(t));
}

// The world position behind an in-range `texel` whose depth `d` has already been sampled.
fn depthWorldPosAt(t: vec2<i32>, d: f32) -> vec3<f32> {
    let size = u_sim.u_collideScreen.xy;
    var uv = (vec2<f32>(t) + 0.5) / size;
    // Texture rows run the other way on WebGPU; undo that to get GL's bottom-up NDC.
    if (u_sim.u_collideScreen.z > 0.5) { uv.y = 1.0 - uv.y; }
    let clip = vec4<f32>(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    let w = u_sim.u_collideInvViewProj * clip;
    return w.xyz / w.w;
}

// Screen-space collision against last frame's opaque depth — Niagara's "Scene Depth" mode. Particles
// off screen, or further behind the visible surface than `thickness`, pass through: depth cannot know
// what is behind what it shows.
fn collideDepth(pos: vec3<f32>, vel: vec3<f32>, radius: f32) -> Contact {
    var miss: Contact;
    miss.hit = false;
    miss.position = pos;
    miss.velocity = vel;
    if (u_sim.u_collideScreen.w < 0.5) { return miss; }
    let clip = u_sim.u_collideViewProj * vec4<f32>(pos, 1.0);
    if (clip.w <= 1e-4) { return miss; }
    let ndc = clip.xyz / clip.w;
    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { return miss; }
    var uv = ndc.xy * 0.5 + 0.5;
    if (u_sim.u_collideScreen.z > 0.5) { uv.y = 1.0 - uv.y; }
    let size = u_sim.u_collideScreen.xy;
    let texel = vec2<i32>(clamp(uv * size, vec2<f32>(0.0), size - 1.0));
    let d = sceneDepthAt(texel);
    if (d >= 0.999999) { return miss; }         // sky

    // `texel` is already clamped in range, and `d` is its depth: no second fetch.
    let surface = depthWorldPosAt(texel, d);
    let cam = u_sim.u_collideCam.xyz;
    // Along the view ray: how far the particle is past the visible surface. Orthographic views share
    // one direction, so compare along the camera axis there instead.
    var behind: f32;
    if (u_sim.u_collideCam.w > 0.5) {
        let axis = normalize((u_sim.u_collideInvViewProj * vec4<f32>(0.0, 0.0, 1.0, 1.0)).xyz
                           / (u_sim.u_collideInvViewProj * vec4<f32>(0.0, 0.0, 1.0, 1.0)).w
                           - (u_sim.u_collideInvViewProj * vec4<f32>(0.0, 0.0, -1.0, 1.0)).xyz
                           / (u_sim.u_collideInvViewProj * vec4<f32>(0.0, 0.0, -1.0, 1.0)).w);
        behind = dot(pos - surface, axis);
    } else {
        behind = distance(cam, pos) - distance(cam, surface);
    }
    if (behind < -radius || behind > u_sim.u_collide1.x + radius) { return miss; }

    // The surface normal from the depth neighbourhood, taking whichever side differs least on each axis
    // so a silhouette edge does not tilt it.
    let px = depthWorldPos(texel + vec2<i32>(1, 0)) - surface;
    let nx = surface - depthWorldPos(texel - vec2<i32>(1, 0));
    let py = depthWorldPos(texel + vec2<i32>(0, 1)) - surface;
    let ny = surface - depthWorldPos(texel - vec2<i32>(0, 1));
    let dx = select(nx, px, dot(px, px) < dot(nx, nx));
    let dy = select(ny, py, dot(py, py) < dot(ny, ny));
    var n = cross(dx, dy);
    if (dot(n, n) < 1e-12) { return miss; }
    n = normalize(n);
    let toCam = select(cam - surface, cam - pos, u_sim.u_collideCam.w > 0.5);
    if (dot(n, toCam) < 0.0) { n = -n; }
    return resolveContact(pos, vel, surface, n, radius);
}

// --- Physics bodies --------------------------------------------------------------------------------

fn quatRotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
    let t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
}

// Bounce off the physics bodies near this system (src/particles/particleColliders.ts packs them each
// frame, world space). Each is tested RELATIVE to its body's velocity, so a moving body bats particles
// away rather than letting them rest on a surface that has left. Applied one after another, so a particle
// wedged in a corner is pushed out of both walls.
fn collideBodies(pos: vec3<f32>, vel: vec3<f32>, radius: f32) -> Contact {
    var out: Contact;
    out.hit = false;
    out.position = pos;
    out.velocity = vel;
    let count = i32(u_sim.u_colliderInfo.x);
    for (var i = 0; i < MAX_PARTICLE_COLLIDERS; i++) {
        if (i >= count) { break; }
        let c0 = u_sim.u_colliders[i * 4];
        let c1 = u_sim.u_colliders[i * 4 + 1];
        let c2 = u_sim.u_colliders[i * 4 + 2];
        let bodyVel = u_sim.u_colliders[i * 4 + 3].xyz;
        let kind = i32(c0.w + 0.5);
        let p = out.position;

        // Every kind reduces to the closest surface point and its outward normal.
        var point = p;
        var normal = vec3<f32>(0.0, 1.0, 0.0);
        var valid = true;
        if (kind == COLLIDER_CAPSULE) {
            let ab = c1.xyz - c0.xyz;
            let len2 = dot(ab, ab);
            let t = select(0.0, clamp(dot(p - c0.xyz, ab) / max(len2, 1e-12), 0.0, 1.0), len2 > 1e-12);
            let axis = c0.xyz + ab * t;
            let d = p - axis;
            let dl = length(d);
            normal = select(vec3<f32>(0.0, 1.0, 0.0), d / max(dl, 1e-6), dl > 1e-6);
            point = axis + normal * c1.w;
        } else if (kind == COLLIDER_BOX) {
            let q = c1;
            let qi = vec4<f32>(-q.xyz, q.w);
            let half = c2.xyz;
            let lp = quatRotate(qi, p - c0.xyz);
            let clamped = clamp(lp, -half, half);
            let d = lp - clamped;
            let dl = length(d);
            var ln: vec3<f32>;
            var lsurf: vec3<f32>;
            if (dl > 1e-6) {
                ln = d / dl;
                lsurf = clamped;
            } else {
                // Inside: out through the nearest face.
                let room = half - abs(lp);
                let s = select(vec3<f32>(-1.0), vec3<f32>(1.0), lp >= vec3<f32>(0.0));
                if (room.x <= room.y && room.x <= room.z) {
                    ln = vec3<f32>(s.x, 0.0, 0.0);
                    lsurf = vec3<f32>(s.x * half.x, lp.y, lp.z);
                } else if (room.y <= room.z) {
                    ln = vec3<f32>(0.0, s.y, 0.0);
                    lsurf = vec3<f32>(lp.x, s.y * half.y, lp.z);
                } else {
                    ln = vec3<f32>(0.0, 0.0, s.z);
                    lsurf = vec3<f32>(lp.x, lp.y, s.z * half.z);
                }
            }
            normal = quatRotate(q, ln);
            point = c0.xyz + quatRotate(q, lsurf);
        } else if (kind == COLLIDER_PLANE) {
            normal = c1.xyz;
            point = c0.xyz;
        } else {
            valid = false;
        }
        if (valid) {
            let c = resolveContact(p, out.velocity - bodyVel, point, normal, radius);
            if (c.hit) {
                out.hit = true;
                out.position = c.position;
                out.velocity = c.velocity + bodyVel;
            }
        }
    }
    return out;
}

// --- Custom --------------------------------------------------------------------------------------

// Replaced, between the markers, by an emitter's custom-code module (src/particles/particleCustomCode.ts).
// The default body does nothing, so the branch below costs one uniform test.
fn particleCustomUpdate(dt: f32, custom: vec4<f32>) {
    let p = &current;
    // @particle-custom-begin
    let unused = dt + custom.x + (*p).age;
    // @particle-custom-end
}

// --- Update --------------------------------------------------------------------------------------

// The particle being stepped, as a private global the update and the custom code both work on in place.
var<private> current: Particle;

fn updateParticle(dt: f32) {
    // Kills are a flag applied once at the end, never a store-and-return inside a branch: see
    // `simulateSlot` for the ANGLE miscompile that made a conditional `lifetime = 0` unconditional.
    var killed = false;
    let mask = u_sim.u_mask.x;
    let isLocal = hasFeature(mask, SIM_LOCAL);
    let life = clamp(current.age / max(1e-4, current.lifetime), 0.0, 1.0);
    var v = current.velocity;
    var x = current.position;

    // World-space position/velocity for the things that live in the world: fields and depth.
    let toWorld = u_sim.u_emitterCur;

    var acc = vec3<f32>(0.0);
    if (hasFeature(mask, SIM_GRAVITY)) { acc = acc + u_sim.u_gravity.xyz; }
    if (hasFeature(mask, SIM_WIND)) { acc = acc + (u_sim.u_wind.xyz - v) * u_sim.u_wind.w; }
#ifndef SIM_STRIP_NOISE
    if (hasFeature(mask, SIM_NOISE)) { acc = acc + turbulence(x) * u_sim.u_noise.x; }
#endif
    if (hasFeature(mask, SIM_VORTEX)) {
        let axis = u_sim.u_vortex.xyz;
        let r = x - u_sim.u_vortexCenter.xyz;
        let radial = r - axis * dot(r, axis);
        let rl = length(radial);
        if (rl > 1e-4) {
            acc = acc + normalize(cross(axis, radial)) * u_sim.u_vortex.w - radial / rl * u_sim.u_vortexCenter.w;
        }
    }
    if (hasFeature(mask, SIM_ATTRACTOR)) {
        let to = u_sim.u_attractor.xyz - x;
        let dist = length(to);
        if (u_sim.u_attractor2.y > 0.0 && dist < u_sim.u_attractor2.y) { killed = true; }
        if (dist > 1e-4) {
            let radius = u_sim.u_attractor2.x;
            let falloff = select(1.0, clamp(1.0 - dist / radius, 0.0, 1.0), radius > 0.0);
            acc = acc + to / dist * u_sim.u_attractor.w * falloff;
        }
    }
#ifndef SIM_STRIP_FIELDS
    if (hasFeature(mask, SIM_FIELDS)) {
        let wp = select(x, transformPoint(toWorld, x), isLocal);
        let wv = select(v, transformDir(toWorld, v), isLocal);
        let wa = forceFieldAccel(wp, wv);
        acc = acc + select(wa, transformDir(u_sim.u_worldToSim, wa), isLocal);
    }
#endif

    // Semi-implicit Euler: velocity first, then position from the NEW velocity — stable for the stiff
    // spring-like forces (wind coupling, vortex pull) where explicit Euler would gain energy.
    v = v + acc * dt;
    if (hasFeature(mask, SIM_DRAG)) { v = v / (1.0 + u_sim.u_gravity.w * dt); }
    if (hasFeature(mask, SIM_LIMIT)) {
        let speed = length(v);
        let cap = u_sim.u_limit.x;
        if (speed > cap && speed > 1e-5) { v = mix(v, v * (cap / speed), clamp(u_sim.u_limit.y, 0.0, 1.0)); }
    }
    var moveScale = 1.0;
    if (hasFeature(mask, SIM_SPEED_LIFE)) { moveScale = particleLut(LUT_SCALARS, life).w; }
    x = x + v * (dt * moveScale);
    if (hasFeature(mask, SIM_FLAT)) { x.z = 0.0; v.z = 0.0; }

    // Collision, in world space.
#ifndef SIM_STRIP_COLLIDE
    let collideDepthOn = hasFeature(mask, SIM_COLLIDE_DEPTH);
    let collidePlanesOn = hasFeature(mask, SIM_COLLIDE_PLANES);
    let collideBodiesOn = hasFeature(mask, SIM_COLLIDE_BODIES);
    if (collideDepthOn || collidePlanesOn || collideBodiesOn) {
        var wp = select(x, transformPoint(toWorld, x), isLocal);
        var wv = select(v, transformDir(toWorld, v), isLocal);
        let radius = max(0.0, current.size * 0.5 * u_sim.u_collide0.x);
        var hit = false;
        if (collidePlanesOn) {
            let count = i32(u_sim.u_collide1.y);
            for (var i = 0; i < MAX_PARTICLE_PLANES; i++) {
                if (i >= count) { break; }
                let plane = u_sim.u_planes[i];
                let point = -plane.xyz * plane.w;
                let c = resolveContact(wp, wv, point, plane.xyz, radius);
                if (c.hit) { hit = true; wp = c.position; wv = c.velocity; }
            }
        }
        if (collideBodiesOn) {
            let c = collideBodies(wp, wv, radius);
            if (c.hit) { hit = true; wp = c.position; wv = c.velocity; }
        }
        if (collideDepthOn) {
            let c = collideDepth(wp, wv, radius);
            if (c.hit) { hit = true; wp = c.position; wv = c.velocity; }
        }
        if (hit) {
            current.seed = current.seed + HIT_FLAG;
            if (hasFeature(mask, SIM_KILL_ON_HIT)) { killed = true; }
            current.age = current.age + current.lifetime * u_sim.u_collide0.w;
            x = select(wp, transformPoint(u_sim.u_worldToSim, wp), isLocal);
            v = select(wv, transformDir(u_sim.u_worldToSim, wv), isLocal);
        }
    }
#endif

    var spinScale = 1.0;
    if (hasFeature(mask, SIM_SPIN_LIFE)) { spinScale = particleLut(LUT_SCALARS, life).z; }
    current.rotation = current.rotation + current.spin * spinScale * dt;
    current.position = x;
    current.velocity = v;

    if (hasFeature(mask, SIM_CUSTOM)) { particleCustomUpdate(dt, u_sim.u_custom); }
    current.lifetime = select(current.lifetime, 0.0, killed);
}

// The whole step for one slot. `slot` is the flat index, `texel` where it lives.
fn simulateSlot(slot: u32, texel: vec2<i32>) -> Particle {
    var p = loadParticle(texel);
    let dt = u_sim.u_step.x;
    let capacity = u32(u_sim.u_step.z);

    p.lifetime = select(p.lifetime, 0.0, u_sim.u_mask.y > 0.5);
    // Last step's collision flag is spent.
    p.seed = fract(p.seed);

    // Inside the ring window -> born this step. Unsigned wraparound does the modulo for free when the
    // window crosses the end of the pool.
    let spawnStart = u32(u_sim.u_spawn.x);
    let spawnCount = u32(u_sim.u_spawn.y);
    let offset = (slot + capacity - spawnStart) % capacity;
    var stepDt = dt;
    // Decide WHETHER and HOW this slot is born, then spawn once: `spawnParticle` is large, and two call
    // sites meant the driver inlined (and compiled) it twice.
    var born = false;
    var spawnIndex = 0u;
    var spawnSeed = 0u;
    var spawnOrigin = vec4<f32>(0.0);
    var spawnVelocity = vec3<f32>(0.0);
    if (offset < spawnCount) {
        born = true;
        spawnIndex = offset;
        spawnSeed = u32(u_sim.u_spawn.z) + offset;
        // Born partway through the step: integrate only what is left of it.
        let birth = (f32(offset) + 0.5) / max(1.0, f32(spawnCount));
        stepDt = dt * (1.0 - birth);
    }

#ifndef SIM_STRIP_SUB
    // Sub-emitter: born from the parent slot this one belongs to, if it had its event this step. It
    // wins over a ring-window birth in the same step, as it always has.
    let event = i32(u_sim.u_sub.x);
    if (event > 0) {
        let perParent = max(1u, u32(u_sim.u_sub.y));
        let parentSlot = slot / perParent;
        if (parentSlot < u32(u_sim.u_sub2.x)) {
            let pt = particleTexel(parentSlot, u32(u_sim.u_sub.w));
            let now0 = textureLoad(u_parentP0_texture, pt, 0);
            let now1 = textureLoad(u_parentP1_texture, pt, 0);
            let was0 = textureLoad(u_parentPrevP0_texture, pt, 0);
            let was1 = textureLoad(u_parentPrevP1_texture, pt, 0);
            var fired = false;
            var at = now0.xyz;
            var vel = now1.xyz;
            if (event == 1) {
                // Death: alive before the parent's step, dead after it. Where it was is where it died.
                fired = was1.w > 0.0 && now1.w <= 0.0;
                at = was0.xyz;
                vel = was1.xyz;
            } else {
                fired = now1.w > 0.0 && textureLoad(u_parentP2_texture, pt, 0).w >= HIT_FLAG;
            }
            if (fired) {
                // A fresh random stream per event: the slot, and the time it fired.
                born = true;
                spawnIndex = 0u;
                spawnSeed = pcgHash(slot ^ pcgHash(bitcast<u32>(u_sim.u_step.y)));
                spawnOrigin = vec4<f32>(at, 1.0);
                spawnVelocity = vel * u_sim.u_sub.z;
                stepDt = 0.0;
            }
        }
    }
#endif
    if (born) { p = spawnParticle(slot, spawnIndex, spawnSeed, spawnOrigin, spawnVelocity); }

    // A variant that strips a module still READS the textures only that module used, behind a branch
    // that never runs (the sim clock is never negative): WebGPU derives its bind-group layout from what
    // the shader uses, and a binding that vanished would fail the bind group every variant shares.
#if defined(SIM_STRIP_SUB) || defined(SIM_STRIP_COLLIDE)
    if (u_sim.u_step.y < -1e30) {
#ifdef SIM_STRIP_SUB
        let o = vec2<i32>(0);
        p.color += textureLoad(u_parentP0_texture, o, 0) + textureLoad(u_parentP1_texture, o, 0)
                 + textureLoad(u_parentP2_texture, o, 0) + textureLoad(u_parentPrevP0_texture, o, 0)
                 + textureLoad(u_parentPrevP1_texture, o, 0);
#endif
#ifdef SIM_STRIP_COLLIDE
        p.color += vec4<f32>(textureSampleLevel(u_sceneDepth_texture, u_sceneDepth_sampler, vec2<f32>(0.5), 0));
#endif
    }
#endif

    // NO conditional stores to the lifetime here, and no early returns: ANGLE's D3D11 backend (Chrome on
    // Windows, the default WebGL2 path) flattened `if (age >= lifetime) { lifetime = 0; return; }` into
    // an UNCONDITIONAL store once the update below was inlined, and every particle died on its first
    // step. Measured on an RTX 3060; the same WGSL was correct on WebGPU. Decide, then `select`.
    let wasAlive = p.lifetime > 0.0;
    p.age = select(p.age, p.age + stepDt, wasAlive);
    let alive = wasAlive && p.age < p.lifetime;
    current = p;
    if (alive) { updateParticle(stepDt); }
    current.lifetime = select(0.0, current.lifetime, alive && current.lifetime > 0.0);
    return current;
}
