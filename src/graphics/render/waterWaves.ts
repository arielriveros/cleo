import { Texture } from '../texture';
import { Framebuffer } from '../framebuffer';
import { device } from '../rhi/deviceHandle';
import { ShaderManager } from '../systems/shaderManager';
import { WaterWaveFieldProgram, WaterWaveAdvectProgram, WaterWaveStepProgram } from './programs';
import type { FullscreenPasses } from './fullscreenPasses';
import type { PassEncoder } from './passEncoder';
import type { WaterInfo } from '../../water/waterInfo';
import type { WaterObstacleFootprint } from '../../water/bake/obstacles';
import { LocalFlowSim } from './localFlow';
import {
    WAVE_SIM_CELL, WAVE_SIM_DEPTHS, WAVE_SIM_DT, WAVE_SIM_GRAVITY, WAVE_SIM_SIZE, WAVE_SIM_TAPS, waveSimKernel,
} from '../../water/waveSim';
import { LOCAL_FLOW_DT } from '../../water/localFlow';

/** One water in reach of the simulated window: its grid, the two textures the surface is drawn from, its bed's Manning's n. */
export interface WaveSimWater { info: WaterInfo; tex0: Texture; tex1: Texture; manning: number; }

/** Metres a side of the simulated window. */
export const WAVE_SIM_SIDE = WAVE_SIM_SIZE * WAVE_SIM_CELL;
/** Texels a side of the field the waves ride on: the current is smooth, half the waves' own grid holds it. */
const FIELD_SIZE = WAVE_SIM_SIZE / 2;
/** The wave (rad/m) whose speed the blend of the two kernels gets right: two metres long, a standing wave's length. */
const BLEND_Q = Math.PI;
/** Obstacles the step is handed at most (waterWaveStep.wgsl OBSTACLE_MAX): the nearest the window's centre. */
const OBSTACLE_MAX = 32;

/**
 * The LIVE WAVES on flowing water: a simulation of surface waves riding the baked current, in a window that
 * follows the camera (water/waveSim.ts has the model and its reference; shaders/wgsl/waterWave*.wgsl run it).
 * Three fullscreen passes a step: the field the waves ride on (the current, depth and foam of every Water
 * node in reach), the waves carried by the current, and the waves propagated and forced. The surface shader
 * (water.wgsl) lifts its vertices by the result and takes its slopes and its foam from it.
 *
 * The window is WAVE_SIM_SIZE texels of WAVE_SIM_CELL metres, about 77 m across, set a little ahead of the
 * camera and moved a whole texel at a time, so what it keeps is carried over exactly. Past it the surface draws
 * its own waves alone. Nothing here reaches the physics: a floating body rides the surface's own waves, as
 * before, not these.
 *
 * The current they ride is the LOCAL FLOW's (render/localFlow.ts): the water simulated again on cells of
 * 0.3 m in the same window, with the bake as its reference, so it piles up against what stands in it, parts
 * round it, pours over a boulder and jumps back up. The window moves two texels at a time, a whole cell of it.
 * What stands in the water (static colliders, as footprints at the surface: water/bake/obstacles.ts) is solid
 * to the waves too, at their own finer grid, and sheds foam and eddies from its sides.
 */
export class WaterWaveSim {
    private readonly _sm = ShaderManager.Instance;
    private _field: Framebuffer | null = null;
    private _carried: Framebuffer | null = null;
    private readonly _states: (Framebuffer | null)[] = [null, null];
    private _read = 0;
    private _kernels: [Float32Array, Float32Array] | null = null;
    private readonly _origin = [0, 0];
    private readonly _stepped = [0, 0];
    private _hasState = false;
    private _time = NaN;
    private _owed = 0;
    private _steps = 0;
    private _live = false;
    /** The noise the turbulence is renewed with: the water's detail texture (its alpha). */
    private _noise: Texture | null = null;
    /** The bulk flow round the camera, when the device can run it. */
    private _flow: LocalFlowSim | null = null;

    constructor(private readonly _passes: PassEncoder, private readonly _fullscreen: FullscreenPasses) {}

    /** Whether this device can run it: the state is signed and small, so it needs float targets it can filter. */
    public static get supported(): boolean {
        return device.capabilities.floatRenderable && device.capabilities.floatFilterable;
    }

    /** Whether there are simulated waves to draw this frame. */
    public get live(): boolean { return this._live; }
    /** The waves: height (m), rate (m/s), turbulence, foam. Valid while {@link live}. */
    public get texture(): Texture { return this._states[this._read]!.colors[0]; }
    /** The window's origin (x, z), metres. */
    public get origin(): readonly number[] { return this._origin; }
    /**
     * The local flow's surface over the same window (`LocalFlowSim.surface`: lift, current x, z, its share), or
     * null where it is not simulated. Valid while {@link live}.
     */
    public get flowSurface(): Texture | null { return this._flow && this._flow.live ? this._flow.surface : null; }

    /**
     * Bring the waves up to `time` (seconds, the water's clock) round a camera at (`cx`, `cz`) looking along
     * (`fx`, `fz`) (its forward's level part, not made a unit), over `waters`; `noise` is the water's detail texture;
     * `obstacles`, what stands in the water. Call before the surface's own pass opens: it records passes of its own.
     * Called again within the same frame (a second viewport pane), it leaves the waves where they are.
     */
    public update(time: number, cx: number, cz: number, fx: number, fz: number, waters: readonly WaveSimWater[], noise: Texture | null = null,
                  obstacles: readonly WaterObstacleFootprint[] = []): void {
        this._noise = noise;
        if (!WaterWaveSim.supported) { this._live = false; return; }
        if (time === this._time && this._live) return;
        const elapsed = time - this._time;
        this._time = time;
        // The window: ahead of the camera, on the grid. Ahead by the level part of where it looks (a camera
        // looking down has the window under it), and by little enough that turning right round moves the
        // window less than half its side: the waves it already holds are kept, not begun again.
        const side = WAVE_SIM_SIDE, cell = WAVE_SIM_CELL;
        const ahead = side * 0.22;
        // Two texels at a time: a whole cell of the local flow, whose grid is half as fine.
        const snap = 2 * cell;
        const ox = Math.round((cx + fx * ahead - side / 2) / snap) * snap;
        const oz = Math.round((cz + fz * ahead - side / 2) / snap) * snap;
        const inReach = waters.filter(w => {
            const i = w.info;
            return i.originX < ox + side && i.originX + i.nx * i.cell > ox && i.originZ < oz + side && i.originZ + i.nz * i.cell > oz;
        });
        if (!inReach.length) { this._live = false; this._hasState = false; this._flow?.stop(); return; }
        // A jump (a new scene, a camera cut, the clock set back) starts the water level. A long frame does
        // not: it is simply not caught up with, and the waves carry on from where they were.
        if (!(elapsed >= 0) || Math.abs(ox - this._origin[0]) > side / 2 || Math.abs(oz - this._origin[1]) > side / 2) {
            this._hasState = false;
            this._owed = WAVE_SIM_DT;
        } else {
            this._owed = Math.min(this._owed + elapsed, WaterWaveSim.MAX_STEPS * WAVE_SIM_DT);
        }
        this._origin[0] = ox; this._origin[1] = oz;
        this._packObstacles(obstacles, ox + side / 2, oz + side / 2);
        this._ensureTargets();
        this._fieldPass(inReach);
        const ref = this._field!.colors[0];
        const flow = LocalFlowSim.supported ? (this._flow ??= new LocalFlowSim(this._passes, this._fullscreen)) : null;
        if (flow) {
            flow.prepare(ox, oz, side, FIELD_SIZE, inReach, this._obstacles, this._obstacleCount,
                datumOf(inReach, ox + side / 2, oz + side / 2, side), ref, !this._hasState);
        }
        let steps = Math.floor(this._owed / WAVE_SIM_DT + 1e-6);
        // Even a frame too short to owe a step leaves a state to draw.
        if (!this._hasState && steps === 0) steps = 1;
        this._owed = Math.max(0, this._owed - steps * WAVE_SIM_DT);
        for (let s = 0; s < steps; s++) {
            if (flow) {
                // The bulk flow first, two substeps to each of the waves' steps, then what the waves ride.
                for (let k = 0; k < LOCAL_FLOW_SUBSTEPS; k++) flow.substep(ref);
                flow.outputWaves(ref);
            }
            this._step(flow ? flow.wavesField : ref);
        }
        flow?.outputSurface(ref);
        this._live = this._hasState;
    }

    private _ensureTargets(): void {
        if (this._field) return;
        const make = (size: number) => new Framebuffer({
            colorTextureOptions: { mipMap: false, precision: 'high', wrapping: 'clamp' }, depth: false,
        }).create(size, size);
        this._field = make(FIELD_SIZE);
        this._carried = make(WAVE_SIM_SIZE);
        this._states[0] = make(WAVE_SIM_SIZE);
        this._states[1] = make(WAVE_SIM_SIZE);
        this._kernels = [waveSimKernel(WAVE_SIM_DEPTHS[0]), waveSimKernel(WAVE_SIM_DEPTHS[1])];
    }

    /** What the waves ride on: each water in reach writes its current, its depth and its foam. */
    private _fieldPass(waters: readonly WaveSimWater[]): void {
        const sm = this._sm;
        const target = this._field!;
        waters.forEach((w, i) => {
            const pass = this._passes.beginFullscreenPass(target.renderTarget, 'water.waves.field', i === 0, [0, 0, 0, 0], false);
            this._fullscreen.bind(pass, 'waterWaveField', WaterWaveFieldProgram, [w.tex0, w.tex1]);
            sm.bind('waterWaveField');
            sm.setUniform('u_window', [this._origin[0], this._origin[1], WAVE_SIM_SIDE, FIELD_SIZE]);
            sm.setUniform('u_infoOrigin', [w.info.originX, w.info.originZ, w.info.cell, 0]);
            sm.setUniform('u_infoSize', [w.info.nx, w.info.nz, 0, 0]);
            this._passes.drawFullscreenAndEnd(pass);
        });
    }

    /** One step: carried by the current `field` holds, then propagated and forced. */
    private _step(field: Texture): void {
        const sm = this._sm;
        const window = [this._origin[0], this._origin[1], WAVE_SIM_SIDE, WAVE_SIM_SIZE];
        const from = this._states[this._read]!, to = this._states[1 - this._read]!;

        const carry = this._passes.beginFullscreenPass(this._carried!.renderTarget, 'water.waves.carry', false, undefined, false);
        this._fullscreen.bind(carry, 'waterWaveAdvect', WaterWaveAdvectProgram, [from.colors[0], field]);
        sm.bind('waterWaveAdvect');
        sm.setUniform('u_window', window);
        sm.setUniform('u_prev', [this._stepped[0], this._stepped[1], WAVE_SIM_DT, this._hasState ? 1 : 0]);
        this._passes.drawFullscreenAndEnd(carry);

        const [shallow, deep] = this._kernels!;
        const pass = this._passes.beginFullscreenPass(to.renderTarget, 'water.waves.step', false, undefined, false);
        this._fullscreen.bind(pass, 'waterWaveStep', WaterWaveStepProgram, [this._carried!.colors[0], field, this._noise ?? field]);
        sm.bind('waterWaveStep');
        sm.setUniform('u_window', window);
        sm.setUniform('u_step', [WAVE_SIM_DT, WAVE_SIM_GRAVITY / WAVE_SIM_CELL, WaterWaveSim.DAMPING, WaterWaveSim.VISCOSITY]);
        sm.setUniform('u_force', [WaterWaveSim.BULK_FORCING, WaterWaveSim.TURBULENCE_FORCING, WaterWaveSim.FOAM_CHURN, (this._steps % 4096) * 0.37]);
        sm.setUniform('u_blend', [Math.tanh(BLEND_Q * WAVE_SIM_DEPTHS[0]), Math.tanh(BLEND_Q * WAVE_SIM_DEPTHS[1]), BLEND_Q, 0]);
        sm.setUniform('u_kernelShallow', WaterWaveSim._packed(shallow, this._kernelA));
        sm.setUniform('u_kernelDeep', WaterWaveSim._packed(deep, this._kernelB));
        sm.setUniform('u_obstacleCount', [this._obstacleCount, 0, 0, 0]);
        if (this._obstacleCount) sm.setUniform('u_obstacles', this._obstacles.subarray(0, this._obstacleCount * 8));
        this._passes.drawFullscreenAndEnd(pass);

        this._read = 1 - this._read;
        this._stepped[0] = this._origin[0]; this._stepped[1] = this._origin[1];
        this._hasState = true;
        this._steps++;
    }

    /** Steps taken in one frame at most: a frame that took longer than this is not caught up with. */
    public static MAX_STEPS = 2;
    /**
     * Per second: how fast a wave nothing feeds dies down. A river's surface forgets in a second or two, so
     * its waves stay near what raised them: rough over the riffles, glassy in the runs between.
     */
    public static DAMPING = 0.6;
    /** The share of each texel's rate shared with its neighbours a step: what the grid cannot carry dies out. */
    public static VISCOSITY = 0.04;
    /** How hard the bulk flow's turns, and the stones under it, raise waves (1: the full vertical acceleration its surface asks for). */
    public static BULK_FORCING = 1;
    /** How hard turbulence pushes the surface. */
    public static TURBULENCE_FORCING = 3;
    /**
     * Per second: the foam churned up where the bake left the water white. Set so the foam carried settles
     * at about a third of the bake's figure on the whole: next to nothing between the streaks, thick in them.
     */
    public static FOAM_CHURN = 0.1;

    private readonly _obstacles = new Float32Array(OBSTACLE_MAX * 8);
    private _obstacleCount = 0;

    /** The obstacles that reach into the window round (`cx`, `cz`), the nearest first, packed for the step. */
    private _packObstacles(list: readonly WaterObstacleFootprint[], cx: number, cz: number): void {
        const half = WAVE_SIM_SIDE / 2 + 3;
        const near = list.filter(o => {
            const reach = Math.max(o.a, o.b) + o.r;
            return Math.abs(o.x - cx) < half + reach && Math.abs(o.z - cz) < half + reach;
        });
        if (near.length > OBSTACLE_MAX) near.sort((p, q) => Math.hypot(p.x - cx, p.z - cz) - Math.hypot(q.x - cx, q.z - cz));
        const out = this._obstacles;
        const count = this._obstacleCount = Math.min(near.length, OBSTACLE_MAX);
        for (let k = 0; k < count; k++) {
            const o = near[k];
            out.set([o.x, o.z, o.ax, o.az, o.a, o.b, o.r, o.under], k * 8);
        }
    }

    private readonly _kernelA = new Float32Array(28);
    private readonly _kernelB = new Float32Array(28);
    private static _packed(kernel: Float32Array, out: Float32Array): Float32Array {
        out.fill(0);
        out.set(kernel.subarray(0, WAVE_SIM_TAPS));
        return out;
    }

    public dispose(): void {
        for (const fbo of [this._field, this._carried, ...this._states]) for (const c of fbo?.colors ?? []) c.delete();
        this._flow?.dispose();
        this._field = null; this._carried = null; this._states[0] = null; this._states[1] = null;
        this._live = false; this._hasState = false;
    }
}

/** The local flow's substeps to each of the waves' steps (WAVE_SIM_DT over LOCAL_FLOW_DT). */
const LOCAL_FLOW_SUBSTEPS = Math.round(WAVE_SIM_DT / LOCAL_FLOW_DT);

/**
 * The height the local flow's heights are taken from: the baked surface at the window's centre, or the mean
 * of the wet samples across it where the centre is dry.
 */
function datumOf(waters: readonly WaveSimWater[], cx: number, cz: number, side: number): number {
    const at = (x: number, z: number): number | null => {
        for (const { info } of waters) {
            const i = Math.floor((x - info.originX) / info.cell + 0.5), j = Math.floor((z - info.originZ) / info.cell + 0.5);
            if (i < 0 || j < 0 || i >= info.nx || j >= info.nz) continue;
            const c = j * info.nx + i;
            if (info.info1[c * 4 + 3] > 0.5) return info.info0[c * 4];
        }
        return null;
    };
    const centre = at(cx, cz);
    if (centre !== null) return centre;
    let sum = 0, count = 0;
    for (let b = -4; b <= 4; b++) for (let a = -4; a <= 4; a++) {
        const v = at(cx + a * side / 9, cz + b * side / 9);
        if (v !== null) { sum += v; count++; }
    }
    return count ? sum / count : 0;
}
