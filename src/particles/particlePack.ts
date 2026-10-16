// An emitter definition, flattened into what the GPU reads: uniform values by name, feature bits, and the
// curve LUT. The ONE place module params turn into numbers, mirrored bit for bit by
// chunks/particleSimCore.wgsl and particleBillboard.wgsl.
//
// Split in two by lifetime: `packEmitter` runs when the definition changes, `stepUniforms` once per
// simulation step for the parts that move with the emitter (matrices, spawn window, gravity in local
// space). GL-free, so both halves are unit tested.

import { mat4, vec3 } from 'gl-matrix';
import {
    LUT_ROW, bakeCurveChannel, bakeGradientRow, identityLut, type Curve, type Gradient,
} from './curves';
import { activeModule, type EmitterDef } from './particleSystemAsset';
import { validatedCustomCode } from './particleCustomCode';
import { SIM_STRIP } from '../graphics/programVariants';
import type { CollisionPlane } from './particleModules';
import type { SimStep } from './particleRuntime';

/** Bits of `u_mask.x` — the SIM_* constants in chunks/particleSimCore.wgsl. */
export const SIM = {
    GRAVITY: 1, DRAG: 2, WIND: 4, NOISE: 8, VORTEX: 16, ATTRACTOR: 32, LIMIT: 64, SPEED_LIFE: 128,
    COLLIDE_DEPTH: 256, COLLIDE_PLANES: 512, SPIN_LIFE: 1024, FIELDS: 2048, LOCAL: 4096,
    KILL_ON_HIT: 8192, CUSTOM: 16384, FLAT: 32768, COLLIDE_BODIES: 65536,
} as const;

/**
 * The modules a simulation variant may compile out for an emitter with `simMask` (SIM_STRIP in
 * programVariants.ts): exactly those its mask already skips at runtime, so the variant computes the
 * same thing as the full program. `hasParent`: the emitter is a sub-emitter, whose births read its
 * parent's state.
 */
export function simStripMask(simMask: number, hasParent: boolean): number {
    let strip = 0;
    if ((simMask & SIM.NOISE) === 0) strip |= SIM_STRIP.NOISE;
    if ((simMask & SIM.FIELDS) === 0) strip |= SIM_STRIP.FIELDS;
    if ((simMask & (SIM.COLLIDE_DEPTH | SIM.COLLIDE_PLANES | SIM.COLLIDE_BODIES)) === 0) strip |= SIM_STRIP.COLLIDE;
    if (!hasParent) strip |= SIM_STRIP.SUB;
    return strip;
}

/** Bits of `u_drawMask.x` — the DRAW_* constants in chunks/particleDraw.wgsl. SORTED is set per frame. */
export const DRAW = { COLOR_LIFE: 1, SIZE_LIFE: 2, COLOR_SPEED: 4, SIZE_SPEED: 8, LOCAL: 16, SORTED: 32 } as const;

const SHAPE_KIND: Record<string, number> = {
    point: 0, sphere: 1, hemisphere: 2, cone: 3, box: 4, circle: 5, edge: 6,
};
const VELOCITY_MODE: Record<string, number> = { shape: 0, direction: 1, radial: 2 };
const COLOR_MODE: Record<string, number> = { constant: 0, between: 1, gradient: 2 };
const ALIGNMENT: Record<string, number> = { camera: 0, velocity: 1, vertical: 2, horizontal: 3 };
const BLEND: Record<string, number> = { alpha: 0, additive: 1, cutout: 2 };

const DEG = Math.PI / 180;
const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const pair = (x: unknown, fallback: [number, number]): [number, number] =>
    Array.isArray(x) ? [num(x[0], fallback[0]), num(x[1], fallback[1])] : fallback;
const triple = (x: unknown, fallback: [number, number, number]): [number, number, number] =>
    Array.isArray(x) ? [num(x[0], fallback[0]), num(x[1], fallback[1]), num(x[2], fallback[2])] : fallback;
const quad = (x: unknown, fallback: [number, number, number, number]): [number, number, number, number] =>
    Array.isArray(x)
        ? [num(x[0], fallback[0]), num(x[1], fallback[1]), num(x[2], fallback[2]), num(x[3], fallback[3])]
        : fallback;

export interface PackedEmitter {
    simMask: number;
    /** The validated custom-code source and its compile, when the emitter runs one. */
    custom: ReturnType<typeof validatedCustomCode>;
    drawMask: number;
    /** Uniforms that never change while the definition does not, by `setUniform` name. */
    sim: Record<string, number[]>;
    draw: Record<string, number[]>;
    frag: Record<string, number[]>;
    lut: Float32Array;
    gravityScale: number;
    /** Emitter-space values `stepUniforms` moves into simulation space each step. */
    windVelocity: [number, number, number];
    windCoupling: number;
    vortexAxis: [number, number, number];
    vortexCenter: [number, number, number];
    vortexStrength: number;
    vortexPull: number;
    attractorPosition: [number, number, number];
    attractorStrength: number;
    planes: CollisionPlane[];
    local: boolean;
}

export function packEmitter(def: EmitterDef, flat2D = false): PackedEmitter {
    let simMask = 0;
    let drawMask = 0;
    const lut = identityLut();
    const sim: Record<string, number[]> = {};
    const draw: Record<string, number[]> = {};
    const frag: Record<string, number[]> = {};
    const local = def.simSpace === 'local';
    if (local) { simMask |= SIM.LOCAL; drawMask |= DRAW.LOCAL; }
    if (flat2D) simMask |= SIM.FLAT;

    // --- Init ---
    const shape = activeModule(def, 'shape')?.params ?? {};
    const box = triple(shape.box, [1, 1, 1]);
    sim.u_shape0 = [SHAPE_KIND[shape.shape] ?? 0, Math.max(0, num(shape.radius, 0)),
                    num(shape.thickness, 1), num(shape.arc, 360) * DEG];
    sim.u_shape1 = [box[0] * 0.5, box[1] * 0.5, box[2] * 0.5, num(shape.angle, 0) * DEG];
    sim.u_shapeOffset = [...triple(shape.offset, [0, 0, 0]), 0];

    const life = pair(activeModule(def, 'lifetime')?.params.range, [1, 1]);
    const size = pair(activeModule(def, 'size')?.params.range, [0.1, 0.1]);
    sim.u_life = [Math.max(1e-3, life[0]), Math.max(1e-3, life[1]), Math.max(0, size[0]), Math.max(0, size[1])];

    const velocity = activeModule(def, 'velocity')?.params;
    const speed = pair(velocity?.speed, [0, 0]);
    const dir = triple(velocity?.direction, [0, 1, 0]);
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    sim.u_speed = [speed[0], speed[1], velocity ? VELOCITY_MODE[velocity.mode] ?? 0 : 0,
                   velocity ? Math.max(0, num(velocity.inherit, 0)) : 0];
    sim.u_dir = [dir[0] / len, dir[1] / len, dir[2] / len, velocity ? num(velocity.spread, 0) * DEG : 0];

    const rotation = activeModule(def, 'rotation')?.params;
    const angle = pair(rotation?.angle, [0, 0]);
    const spin = pair(rotation?.spin, [0, 0]);
    sim.u_rot = [angle[0] * DEG, angle[1] * DEG, spin[0] * DEG, spin[1] * DEG];

    const color = activeModule(def, 'color')?.params;
    sim.u_colorA = quad(color?.colorA, [1, 1, 1, 1]);
    sim.u_colorB = quad(color?.colorB, [1, 1, 1, 1]);
    sim.u_colorMode = [color ? COLOR_MODE[color.mode] ?? 0 : 0, color ? Math.max(0, num(color.intensity, 1)) : 1, 0, 0];
    if (color?.mode === 'gradient' && color.gradient) bakeGradientRow(lut, LUT_ROW.INIT_COLOR, color.gradient as Gradient);

    // --- Update ---
    const gravity = activeModule(def, 'gravity');
    const gravityScale = gravity ? num(gravity.params.scale, 1) : 0;
    if (gravity) simMask |= SIM.GRAVITY;

    const drag = activeModule(def, 'drag');
    const dragCoefficient = drag ? Math.max(0, num(drag.params.coefficient, 0)) : 0;
    if (drag) simMask |= SIM.DRAG;
    // u_gravity.w is the drag coefficient; xyz is filled per step.
    sim.u_gravity = [0, 0, 0, dragCoefficient];

    const wind = activeModule(def, 'wind')?.params;
    if (wind) simMask |= SIM.WIND;

    const noise = activeModule(def, 'curlNoise')?.params;
    if (noise) simMask |= SIM.NOISE;
    sim.u_noise = noise
        ? [num(noise.strength, 1), Math.max(1e-3, num(noise.frequency, 1)), num(noise.scroll, 0),
           Math.min(3, Math.max(1, Math.floor(num(noise.octaves, 1))))]
        : [0, 1, 0, 1];

    const vortex = activeModule(def, 'vortex')?.params;
    if (vortex) simMask |= SIM.VORTEX;

    const attractor = activeModule(def, 'attractor')?.params;
    if (attractor) simMask |= SIM.ATTRACTOR;
    sim.u_attractor2 = attractor
        ? [Math.max(0, num(attractor.radius, 0)), Math.max(0, num(attractor.killRadius, 0)), 0, 0]
        : [0, 0, 0, 0];

    const limit = activeModule(def, 'limitVelocity')?.params;
    if (limit) simMask |= SIM.LIMIT;
    sim.u_limit = limit ? [Math.max(0, num(limit.maxSpeed, 0)), num(limit.dampen, 1), 0, 0] : [0, 0, 0, 0];

    const fields = activeModule(def, 'forceFields')?.params;
    if (fields) simMask |= SIM.FIELDS;

    const speedLife = activeModule(def, 'speedOverLife')?.params;
    if (speedLife?.curve) { simMask |= SIM.SPEED_LIFE; bakeCurveChannel(lut, LUT_ROW.SCALARS, 3, speedLife.curve as Curve); }

    const spinLife = activeModule(def, 'rotationOverLife')?.params;
    if (spinLife?.curve) { simMask |= SIM.SPIN_LIFE; bakeCurveChannel(lut, LUT_ROW.SCALARS, 2, spinLife.curve as Curve); }

    const collision = activeModule(def, 'collision')?.params;
    const planes: CollisionPlane[] = [];
    if (collision) {
        if (collision.depth !== false) simMask |= SIM.COLLIDE_DEPTH;
        // Opt-in: an asset authored before physics collision existed keeps exactly what it did.
        if (collision.bodies === true) simMask |= SIM.COLLIDE_BODIES;
        if (Array.isArray(collision.planes))
            for (const p of collision.planes.slice(0, 4))
                planes.push({ point: triple(p?.point, [0, 0, 0]), normal: triple(p?.normal, [0, 1, 0]) });
        if (planes.length) simMask |= SIM.COLLIDE_PLANES;
        if (collision.kill === true) simMask |= SIM.KILL_ON_HIT;
        sim.u_collide0 = [Math.max(0, num(collision.radius, 0.5)), num(collision.restitution, 0.4),
                          num(collision.friction, 0.2), Math.max(0, num(collision.lifetimeLoss, 0))];
        sim.u_collide1 = [Math.max(0.01, num(collision.thickness, 0.5)), planes.length, 0, 0];
    } else {
        sim.u_collide0 = [0, 0, 0, 0];
        sim.u_collide1 = [0, 0, 0, 0];
    }

    // Only a VALIDATED compile of this exact source runs; see particleCustomCode.ts.
    const customModule = activeModule(def, 'customCode');
    const custom = validatedCustomCode(customModule);
    if (custom) simMask |= SIM.CUSTOM;
    sim.u_custom = custom ? quad(customModule!.params.params, [0, 0, 0, 0]) : [0, 0, 0, 0];

    // --- Render-time modules ---
    const colorLife = activeModule(def, 'colorOverLife')?.params;
    if (colorLife?.gradient) { drawMask |= DRAW.COLOR_LIFE; bakeGradientRow(lut, LUT_ROW.COLOR_OVER_LIFE, colorLife.gradient as Gradient); }

    const sizeLife = activeModule(def, 'sizeOverLife')?.params;
    if (sizeLife?.curve) { drawMask |= DRAW.SIZE_LIFE; bakeCurveChannel(lut, LUT_ROW.SCALARS, 0, sizeLife.curve as Curve); }

    const colorSpeed = activeModule(def, 'colorBySpeed')?.params;
    const colorSpeedRange = pair(colorSpeed?.speed, [0, 1]);
    if (colorSpeed?.gradient) { drawMask |= DRAW.COLOR_SPEED; bakeGradientRow(lut, LUT_ROW.COLOR_BY_SPEED, colorSpeed.gradient as Gradient); }

    const sizeSpeed = activeModule(def, 'sizeBySpeed')?.params;
    const sizeSpeedRange = pair(sizeSpeed?.speed, [0, 1]);
    if (sizeSpeed?.curve) { drawMask |= DRAW.SIZE_SPEED; bakeCurveChannel(lut, LUT_ROW.SCALARS, 1, sizeSpeed.curve as Curve); }

    const render = def.render;
    const fb = render.flipbook;
    draw.u_drawMask = [drawMask, 1, 0, 0];
    draw.u_flipbook = [fb.columns, fb.rows, Math.min(fb.frames, fb.columns * fb.rows), fb.mode === 'fps' ? 1 : 0];
    draw.u_flipbook2 = [fb.fps, fb.cycles, fb.randomStart ? 1 : 0, fb.blend && fb.frames > 1 ? 1 : 0];
    draw.u_speedRange = [colorSpeedRange[0], colorSpeedRange[1], sizeSpeedRange[0], sizeSpeedRange[1]];
    draw.alignment = [ALIGNMENT[render.alignment] ?? 0];
    draw.stretch = [render.stretch];
    frag.u_fragParams = [BLEND[render.blend] ?? 0, render.cutoff, render.softness, render.emissive];

    return {
        simMask, drawMask, sim, draw, frag, lut, gravityScale, local, planes, custom,
        windVelocity: triple(wind?.velocity, [0, 0, 0]),
        windCoupling: wind ? Math.max(0, num(wind.influence, 1)) : 0,
        vortexAxis: triple(vortex?.axis, [0, 1, 0]),
        vortexCenter: triple(vortex?.center, [0, 0, 0]),
        vortexStrength: vortex ? num(vortex.strength, 0) : 0,
        vortexPull: vortex ? num(vortex.pull, 0) : 0,
        attractorPosition: triple(attractor?.position, [0, 0, 0]),
        attractorStrength: attractor ? num(attractor.strength, 0) : 0,
    };
}

const _v = vec3.create();

function rotateDir(m: mat4, d: readonly number[], normalize: boolean): [number, number, number] {
    vec3.set(_v, d[0], d[1], d[2]);
    vec3.transformMat4(_v, _v, mat4.fromValues(m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1));
    if (normalize) vec3.normalize(_v, _v);
    return [_v[0], _v[1], _v[2]];
}

function transformPoint(m: mat4, p: readonly number[]): [number, number, number] {
    vec3.set(_v, p[0], p[1], p[2]);
    vec3.transformMat4(_v, _v, m);
    return [_v[0], _v[1], _v[2]];
}

/**
 * The per-step uniforms. Emitter-space authoring (vortex, attractor, planes) moves into simulation space:
 * world space through the emitter's current matrix, or nothing at all for a local-space emitter. World
 * quantities (gravity, wind) go the other way for a local-space one.
 */
export function stepUniforms(packed: PackedEmitter, step: SimStep, capacity: number, width: number,
                             gravity: readonly number[], seed: number): Record<string, number[] | Float32Array> {
    const world = step.matrix;
    const worldToSim = packed.local ? mat4.invert(mat4.create(), world) ?? mat4.create() : mat4.create();
    const toSim = (d: readonly number[]) => (packed.local ? rotateDir(worldToSim, d, false) : [d[0], d[1], d[2]]);
    const fromEmitterPoint = (p: readonly number[]) => (packed.local ? [p[0], p[1], p[2]] : transformPoint(world, p));
    const fromEmitterDir = (d: readonly number[]) => (packed.local ? (() => {
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        return [d[0] / l, d[1] / l, d[2] / l];
    })() : rotateDir(world, d, true));

    const g = toSim([gravity[0] * packed.gravityScale, gravity[1] * packed.gravityScale, gravity[2] * packed.gravityScale]);
    const wind = toSim(packed.windVelocity);

    // Planes are authored in emitter space and evaluated in WORLD space (that is where collision runs),
    // as n . p + d = 0.
    const planes = new Float32Array(16);
    packed.planes.forEach((plane, i) => {
        const point = transformPoint(world, plane.point);
        const normal = rotateDir(world, plane.normal, true);
        planes.set([normal[0], normal[1], normal[2], -(normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2])], i * 4);
    });

    return {
        u_emitterPrev: step.prevMatrix as Float32Array,
        u_emitterCur: world as Float32Array,
        u_worldToSim: worldToSim as Float32Array,
        u_step: [step.dt, step.time, capacity, width],
        u_spawn: [step.spawnStart, step.spawnCount, step.serial, seed],
        u_mask: [packed.simMask, step.reset ? 1 : 0, 0, 0],
        u_emitterVel: [step.velocity[0], step.velocity[1], step.velocity[2], 0],
        u_gravity: [g[0], g[1], g[2], packed.sim.u_gravity[3]],
        u_wind: [wind[0], wind[1], wind[2], packed.windCoupling],
        u_vortex: [...fromEmitterDir(packed.vortexAxis), packed.vortexStrength],
        u_vortexCenter: [...fromEmitterPoint(packed.vortexCenter), packed.vortexPull],
        u_attractor: [...fromEmitterPoint(packed.attractorPosition), packed.attractorStrength],
        u_planes: planes,
    };
}

