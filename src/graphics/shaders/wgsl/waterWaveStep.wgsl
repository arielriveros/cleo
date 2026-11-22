// LIVE WAVES, step 2 (render/waterWaves.ts; the model and its reference are water/waveSim.ts): the waves
// carried here by step 1 PROPAGATE, and are raised.
//
//     d2(eta)/dt2 = -g K eta + forcing
//
// K is the operator whose symbol is k tanh(k h), water's own dispersion relation over a depth h, applied as a
// thirteen by thirteen convolution (Tessendorf's iWave, with a kernel fitted to the symbol in metres:
// waveSim.ts waveSimKernel). Two kernels, for shallow and for deep water, blended by the depth here. Every
// wavelength then runs at its own speed, and that is the whole of why a train of waves stands below a drop:
// the one length that runs upstream as fast as the current runs down stays where it is.
//
// What raises them:
//  - the BULK FLOW itself. The flow bake's surface is the shallow-water one, which lets the water turn a
//    corner in its fall as sharply as it likes. Real water cannot: where its path curves it overshoots, and the
//    overshoot is the first trough of an undular train. The forcing is the vertical acceleration the bulk
//    surface asks of the water moving along it, speed squared times the curvature of its path, with the
//    surface's height read off the speed (Bernoulli: the surface drops as the water speeds up);
//  - TURBULENCE. A fast, rough river boils: its bed's eddies reach the surface as pressure that comes and
//    goes. A random field carried with the water (it fades and is renewed over half a second) pushes the
//    surface, harder the faster the water runs and hardest where the bake found it losing its energy;
//  - STONES. What the bake's grid is too coarse to hold: stones a foot or two across, just under the
//    surface, one to every ten square metres of bed or so, fixed in place. The water rides up over each and
//    drops behind it (a push that does not change, up over the stone and down round it, adding no water, as
//    strong as the water's speed squared), and a push that stands still in a current leaves a wake that
//    stands still: the V below every stone in fast water. They are not drawn: the bed shows none.
//  - WHAT STANDS IN THE WATER: the static colliders in the window (u_obstacles: water/bake/obstacles.ts
//    footprints, at the surface). The current the waves ride is the local flow's (render/localFlow.ts), which
//    already piles against them, parts round them and pours over the ones under the surface, so the bulk
//    flow's forcing above raises the bow wave, the standing waves and the jump. Here they are solid to the
//    waves at the waves' own finer grid, as an obstruction is in iWave: nothing inside, so a wave that reaches
//    one is thrown back; the water boils in the lee, and foam is torn from their sides and carried off in
//    two streaks.
//  - WHAT MOVES THROUGH IT: the bodies crossing the surface in the window (u_bodies: core/scene/nodes/
//    waterVolumeNode.ts disturbances, on the layers the water reacts to), each a smooth bump its waterline
//    wide, pressed down as it sinks in and raised as it rises out, raised ahead of it and drawn down behind as
//    it moves through, against the water's own motion (water/waveSim.ts bodyWavePush, the CPU twin). The
//    operator makes the ring of a stone, the bow wave and the V of a wake of it; the current carries them off.
//    A body that comes in fast, or ploughs through, churns a little foam up.
//
// And what the waves make: FOAM, where they steepen past what a wave can hold (they break, and are damped
// for it), added to what the rocks and the turbulence churn up where the bake found the water white. Carried
// by step 1, fading here: so it trails from each rock in a streak as long as it lasts.
//
// State as in step 1: r height (m), g rate (m/s), b turbulence, a foam.

#include "./chunks/fullscreen.wgsl"

@group(0) @binding(0) var u_state_texture: texture_2d<f32>;   // the state as step 1 left it
@group(0) @binding(1) var u_state_sampler: sampler;
@group(0) @binding(2) var u_field_texture: texture_2d<f32>;   // current x, z (m/s), depth (m), baked foam
@group(0) @binding(3) var u_field_sampler: sampler;
// The water's detail texture (water/waterTextures.ts): its blue is noise made from a spectrum that is a
// ring, so it has no grid in it and no direction. Read at a new place every step, it is the noise the
// turbulence is renewed with (a lattice noise here prints its lattice on the water as rows of dimples).
@group(0) @binding(4) var u_noise_texture: texture_2d<f32>;
@group(0) @binding(5) var u_noise_sampler: sampler;

struct StepUniforms {
    u_window: vec4<f32>,       // origin x, origin z (m), side (m), texels a side
    u_step: vec4<f32>,         // the step (s), g / texel (1/s2), damping (1/s), viscosity (share of the rate smoothed a step)
    u_force: vec4<f32>,        // bulk-flow forcing, turbulence forcing, foam the turbulence churns up (1/s), this step's seed
    u_blend: vec4<f32>,        // tanh(q h) of the shallow kernel's depth, of the deep one's, q (rad/m), -
    u_kernelShallow: array<vec4<f32>, 7>,
    u_kernelDeep: array<vec4<f32>, 7>,
    u_obstacleCount: vec4<f32>,  // obstacles in u_obstacles, -, -, -
    // Two per obstacle: its centre x, z and long axis x, z; half its length and width, its rounding (m), and
    // metres its top lies under the surface (0: it stands out of the water).
    u_obstacles: array<vec4<f32>, 64>,
    u_bodyCount: vec4<f32>,      // bodies in u_bodies, still water's damping (1/s), -, -
    // Two per body: its centre x, z, waterline radius (m) and how much of it the surface cuts (0..1); its
    // velocity against the water x, y (up), z (m/s), -.
    u_bodies: array<vec4<f32>, 64>,
};
@group(1) @binding(0) var<uniform> u_ws: StepUniforms;

const REACH: i32 = 6;
const G: f32 = 9.81;
/** Metres a side of the cell each stone sits in, and the share of cells that have one. */
const STONE_CELL: f32 = 2.3;
const STONE_SHARE: f32 = 0.55;
/** How hard the water is pushed up over a stone, as a share of its speed squared (1/m): a pillow most of the velocity head high, as water piles on a rock. */
const STONE_PUSH: f32 = 3.0;
/** How much more foam a stone churns up than open water does. */
const STONE_FOAM: f32 = 120.0;
/** Seconds the turbulence keeps its shape, and the foam lasts. */
const TURBULENCE_LIFE: f32 = 0.5;
const FOAM_LIFE: f32 = 3.5;
/** The steepest a wave stands (rise over run) before it breaks. */
const BREAKING: f32 = 0.32;
/** Obstacles in u_obstacles at most. */
const OBSTACLE_MAX: i32 = 32;
/** Per second: the foam torn from an obstacle's sides and lee in fast water. */
const OBSTACLE_FOAM: f32 = 12.0;
/** Bodies in u_bodies at most (water/waveSim.ts WAVE_SIM_BODY_MAX). */
const BODY_MAX: i32 = 32;
/** water/waveSim.ts BODY_PUSH_VERTICAL, BODY_PUSH_HORIZONTAL, BODY_SPEED_CAP, BODY_REACH. */
const BODY_PUSH_VERTICAL: f32 = 1.6;
const BODY_PUSH_HORIZONTAL: f32 = 1.5;
const BODY_SPEED_CAP: f32 = 6.0;
const BODY_REACH: f32 = 3.0;
/** Per second, per m/s past what churns none: the foam a body throws up coming in fast or ploughing through. */
const BODY_FOAM: f32 = 1.0;

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn stateAt(c: vec2<f32>) -> vec4<f32> {
    let n = u_ws.u_window.w;
    if (c.x < 0.0 || c.y < 0.0 || c.x >= n || c.y >= n) { return vec4<f32>(0.0); }
    return textureSampleLevel(u_state_texture, u_state_sampler, (c + vec2<f32>(0.5)) / n, 0.0);
}

fn fieldAt(uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(u_field_texture, u_field_sampler, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let n = u_ws.u_window.w;
    let cell = u_ws.u_window.z / n;
    let c = floor(in.position.xy);
    let uv = in.position.xy / n;
    let field = fieldAt(uv);
    let depth = field.z;
    if (depth <= 0.0) { return vec4<f32>(0.0); }
    let dt = u_ws.u_step.x;
    let s = stateAt(c);

    // The wave operator: the two kernels, blended so the wave that matters most (u_blend.z) gets its speed.
    let mixing = clamp((tanh(u_ws.u_blend.z * depth) - u_ws.u_blend.x) / max(u_ws.u_blend.y - u_ws.u_blend.x, 1e-3), 0.0, 1.0);
    var conv = 0.0;
    for (var j = -REACH; j <= REACH; j++) {
        for (var i = -REACH; i <= REACH; i++) {
            let a = abs(i);
            let b = abs(j);
            let lo = min(a, b);
            let hi = max(a, b);
            let k = hi * (hi + 1) / 2 + lo;
            let w = mix(u_ws.u_kernelShallow[k / 4][k % 4], u_ws.u_kernelDeep[k / 4][k % 4], mixing);
            conv += w * stateAt(c + vec2<f32>(f32(i), f32(j))).x;
        }
    }
    let l = stateAt(c - vec2<f32>(1.0, 0.0));
    let r = stateAt(c + vec2<f32>(1.0, 0.0));
    let d = stateAt(c - vec2<f32>(0.0, 1.0));
    let u = stateAt(c + vec2<f32>(0.0, 1.0));

    // The bulk flow's forcing: the curvature of the water's path, from its speed a stride and a half up and
    // downstream (any nearer and it is the bake's own grid that is measured, and printed on the water).
    let flow = field.xy;
    let speed2 = dot(flow, flow);
    var push = 0.0;
    if (speed2 > 0.01) {
        let along = flow * inverseSqrt(speed2);
        let reach = 1.5;
        let ahead = fieldAt(uv + along * reach / u_ws.u_window.z);
        let behind = fieldAt(uv - along * reach / u_ws.u_window.z);
        // Only between wet water: at a bank the speed falls to nothing, and that is no drop.
        if (ahead.z > 0.0 && behind.z > 0.0) {
            let bend = (dot(ahead.xy, ahead.xy) - 2.0 * speed2 + dot(behind.xy, behind.xy)) / (reach * reach);
            push = u_ws.u_force.x * speed2 * bend / (2.0 * G);
        }
    }
    let xz = u_ws.u_window.xy + uv * u_ws.u_window.z;
    // What stands in the water: solid, piled against, boiling and white in its lee.
    let along = select(vec2<f32>(0.0), flow * inverseSqrt(max(speed2, 1e-8)), speed2 > 1e-4);
    var shed = 0.0;
    var stir = 0.0;
    let obstacles = min(i32(u_ws.u_obstacleCount.x), OBSTACLE_MAX);
    for (var k = 0; k < obstacles; k++) {
        let o0 = u_ws.u_obstacles[2 * k];
        let o1 = u_ws.u_obstacles[2 * k + 1];
        let rel = xz - o0.xy;
        let across = vec2<f32>(-o0.w, o0.z);
        let p = vec2<f32>(dot(rel, o0.zw), dot(rel, across));
        let q = abs(p) - o1.xy;
        let outside = max(q, vec2<f32>(0.0));
        let past = length(outside);
        // How far out of its rounded rectangle (negative inside).
        let e = past + min(max(q.x, q.y), 0.0) - o1.z;
        if (e > 3.0) { continue; }
        if (o1.w <= 0.0) {
            if (e < 0.0) { return vec4<f32>(0.0); }
            // Its face's outward normal, and how squarely the current meets it (-1: head on).
            var nl = select(vec2<f32>(0.0, sign(p.y)), vec2<f32>(sign(p.x), 0.0), q.x >= q.y);
            if (past > 1e-5) { nl = outside / past * sign(p); }
            let facing = dot(o0.zw * nl.x + across * nl.y, along);
            let edge = e / 0.3;
            shed += exp(-edge * edge) * (0.25 + 0.75 * smoothstep(-0.5, 0.5, facing));
            // Its wake: the eddies it sheds, carried off downstream in a band as wide as it is across the
            // current and widening as it goes, dying out over some eight of its widths.
            let side = vec2<f32>(-along.y, along.x);
            let wide = o1.x * abs(dot(o0.zw, side)) + o1.y * abs(dot(across, side)) + o1.z + 0.05;
            let down = dot(rel, along);
            if (down > 0.0 && speed2 > 0.01) {
                let width = wide + 0.25 * down;
                let off = dot(rel, side) / width;
                let wake = exp(-off * off) * exp(-down / (8.0 * wide));
                stir += wake;
                shed += 0.3 * wake;
            }
        } else if (e < 0.0) {
            // Over one just under the surface: white where it nearly breaks the surface (the local flow
            // raises its pillow and its jump).
            shed += 0.5 * exp(-o1.w / 0.25);
        }
    }
    stir = min(stir, 1.5);
    // What moves through the water: pushed under each body, against the water's own motion.
    var thrown = 0.0;
    let bodies = min(i32(u_ws.u_bodyCount.x), BODY_MAX);
    for (var k = 0; k < bodies; k++) {
        let b0 = u_ws.u_bodies[2 * k];
        let b1 = u_ws.u_bodies[2 * k + 1];
        let wide = max(b0.z, 1.5 * cell);
        let rel = (xz - b0.xy) / wide;
        let d2 = dot(rel, rel);
        if (d2 > BODY_REACH * BODY_REACH || b0.w <= 0.0) { continue; }
        let profile = exp(-2.0 * d2) * b0.w;
        let vy = clamp(b1.y, -BODY_SPEED_CAP, BODY_SPEED_CAP);
        let planar = length(b1.xz);
        let slow = select(1.0, BODY_SPEED_CAP / planar, planar > BODY_SPEED_CAP);
        push += profile * (BODY_PUSH_VERTICAL * vy + BODY_PUSH_HORIZONTAL * dot(rel, b1.xz) * slow);
        thrown += profile * (max(abs(vy) - 1.0, 0.0) + max(planar * slow - 1.5, 0.0));
    }
    // Turbulence, carried with the water: renewed a little every step with noise as broad as a boil.
    let seed = u_ws.u_force.w;
    let shift = vec2<f32>(hash12(vec2<f32>(seed, 1.7)), hash12(vec2<f32>(seed, 9.2)));
    // (Boils a stride across with ones a foot across among them.)
    let fresh = ((textureSampleLevel(u_noise_texture, u_noise_sampler, xz / 7.0 + shift, 0.0).b - 0.5)
               + (textureSampleLevel(u_noise_texture, u_noise_sampler, xz.yx / 3.1 - shift.yx, 0.0).b - 0.5) * 0.6) * 6.0;
    let renew = dt / TURBULENCE_LIFE;
    let turbulence = clamp(s.z * (1.0 - renew) + fresh * sqrt(2.0 * renew) * (1.0 + 2.0 * stir), -3.0, 3.0);
    // A bed is not rough alike all over: boulders here, gravel there. The same noise read broad and fixed in
    // place says which, so a river has its riffles and, between them, its glassy runs.
    let bed = clamp((textureSampleLevel(u_noise_texture, u_noise_sampler, xz / 90.0 + vec2<f32>(0.21, 0.67), 0.0).b - 0.5) * 7.0 + 1.0, 0.1, 2.6);
    let rough = speed2 * ((0.03 + 0.22 * field.w) * bed + 0.2 * stir);
    push += u_ws.u_force.y * rough * turbulence;
    // The stone of this cell of the bed, if it has one: up over its top, down round it, nothing a few
    // radii out (a profile whose sum over the plane is nought).
    let site = floor(xz / STONE_CELL);
    var stone = 0.0;
    if (hash12(site + vec2<f32>(3.1, 8.7)) < STONE_SHARE) {
        let at = (site + vec2<f32>(0.3) + 0.4 * vec2<f32>(hash12(site), hash12(site + vec2<f32>(19.3, 5.1)))) * STONE_CELL;
        let radius = 0.14 + 0.16 * hash12(site + vec2<f32>(7.7, 2.9));
        let away = (xz - at) / radius;
        let d2 = dot(away, away);
        stone = (1.0 - d2) * exp(-d2);
    }
    push += u_ws.u_force.x * STONE_PUSH * speed2 * stone;

    // The rate, then the height. Thin water and the window's edge calm the waves; a breaking one spends itself.
    let grad = vec2<f32>(r.x - l.x, u.x - d.x) / (2.0 * cell);
    let steep = length(grad);
    let breaking = max(steep - BREAKING, 0.0);
    let border = min(min(c.x, c.y), min(n - 1.0 - c.x, n - 1.0 - c.y));
    let sponge = 1.0 - smoothstep(4.0, 24.0, border);
    let shallow = 1.0 - smoothstep(0.03, 0.2, depth);
    // Running water forgets its waves in a second or two; still water carries a stone's rings for many
    // (water/waveSim.ts waveDamping).
    let base = mix(u_ws.u_bodyCount.y, u_ws.u_step.z, smoothstep(0.1, 0.6, sqrt(speed2)));
    let damping = base + 12.0 * breaking + 6.0 * sponge + 4.0 * shallow;
    var rate = s.y + dt * (-u_ws.u_step.y * conv + push);
    // A little of the rate is shared with its neighbours: what the grid cannot carry as a wave dies out.
    rate = mix(rate, 0.25 * (l.y + r.y + d.y + u.y), u_ws.u_step.w);
    rate *= exp(-damping * dt);
    var height = s.x + dt * rate;
    // No wave stands taller than the water under it lets it.
    let tallest = 0.4 * depth;
    height = clamp(height, -tallest, tallest);

    // Foam: what breaks, and what is churned up where the bake found the water white. What whitens water
    // sits on the bed and stays there, so most of it is made at the stones and leaves each in a line (made
    // all over, it would be carried into an even grey: a streak needs a source the water passes in a
    // moment); the turbulence's gusts make the rest.
    let running = smoothstep(0.2, 0.6, sqrt(speed2));
    let churn = u_ws.u_force.z * field.w * (0.05 + STONE_FOAM * max(stone, 0.0) + 0.5 * max(turbulence, 0.0) * bed) * running
              + OBSTACLE_FOAM * shed * smoothstep(0.3, 1.2, sqrt(speed2))
              + BODY_FOAM * thrown;
    let foam = clamp(s.w * exp(-dt / FOAM_LIFE) + dt * (churn + 1.5 * breaking), 0.0, 1.5);
    return vec4<f32>(height, rate, turbulence, foam);
}
