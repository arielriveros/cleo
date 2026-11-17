import { Texture } from '../texture';
import { Framebuffer } from '../framebuffer';
import { device } from '../rhi/deviceHandle';
import { ShaderManager } from '../systems/shaderManager';
import {
    WaterFlowGroundProgram, WaterFlowShiftProgram, WaterFlowAdvectProgram, WaterFlowLimitProgram, WaterFlowDepthProgram,
    WaterFlowAccelerateProgram, WaterFlowWavesProgram, WaterFlowSurfaceProgram,
} from './programs';
import type { FullscreenPasses } from './fullscreenPasses';
import type { PassEncoder } from './passEncoder';
import type { PipelineReflection } from './pipelineCache';
import type { WaterInfo } from '../../water/waterInfo';
import { LOCAL_FLOW_DT } from '../../water/localFlow';

/** One water in reach of the window, as the local flow reads it: its grid, the textures it is drawn from, its bed's roughness. */
export interface LocalFlowWater { info: WaterInfo; tex0: Texture; tex1: Texture; manning: number; }

/**
 * The LOCAL FLOW: the water simulated finely round the camera, so what stands in it shapes it (the model, its
 * CPU reference and its constants are water/localFlow.ts; the passes are shaders/wgsl/waterFlow*.wgsl). It runs
 * on the live waves' window (render/waterWaves.ts, which drives it), one cell to two of the waves' texels, with
 * the flow bake's water as its reference and its boundary:
 *
 *  - every frame, the GROUND: each water's bed and baked surface over the window, and the obstacles in it;
 *  - when the window moves, the state carried over by whole cells (the new strip started from the bake);
 *  - each substep, four passes (advect, limit, depth, accelerate), two to each of the waves' steps;
 *  - then what it hands on: the field the live waves ride (current, depth, foam with its whitewater) and the
 *    surface's lift and current (water.wgsl reads them round the camera).
 *
 * Depths and velocities are 32-bit floats, read by `textureLoad` only (they need not filter): what float
 * render targets allow wherever the live waves run.
 */
export class LocalFlowSim {
    private readonly _sm = ShaderManager.Instance;
    private _ground: Framebuffer | null = null;
    private readonly _depths: (Framebuffer | null)[] = [null, null];
    private readonly _velocities: (Framebuffer | null)[] = [null, null];
    private _waves: Framebuffer | null = null;
    private _surface: Framebuffer | null = null;
    private _depthRead = 0;
    private _velRead = 0;
    private _hasState = false;
    private readonly _origin = [NaN, NaN];
    private _cells = 0;
    private _cell = 0;
    private _live = false;

    constructor(private readonly _passes: PassEncoder, private readonly _fullscreen: FullscreenPasses) {}

    /** Whether this device can run it: 32-bit float render targets. */
    public static get supported(): boolean { return device.capabilities.floatRenderable; }

    /** Whether it holds water this frame. */
    public get live(): boolean { return this._live; }
    /** The field the live waves ride: current x, z (m/s), depth (m), foam. */
    public get wavesField(): Texture { return this._waves!.colors[0]; }
    /** The surface's lift over the bake (m), the current x, z (m/s), and how much of it is the local flow's. */
    public get surface(): Texture { return this._surface!.colors[0]; }

    /**
     * Ready the window for this frame: its origin (whole cells of `side / cells`), the ground under it from
     * `waters` and the `obstacles` (packed as the live waves pack them, `count` of them), heights relative to
     * `datum`. `fresh`: start from the bake (a jump), not from what the window held.
     */
    public prepare(ox: number, oz: number, side: number, cells: number, waters: readonly LocalFlowWater[],
                   obstacles: Float32Array, count: number, datum: number, ref: Texture, fresh: boolean): void {
        this._ensureTargets(cells);
        this._cells = cells; this._cell = side / cells;
        this._groundPass(ox, oz, side, cells, waters, obstacles, count, datum);
        let dx = Math.round((ox - this._origin[0]) / this._cell), dz = Math.round((oz - this._origin[1]) / this._cell);
        if (fresh || !this._hasState || !Number.isFinite(dx) || !Number.isFinite(dz)) { dx = 1e6; dz = 1e6; }
        if (dx !== 0 || dz !== 0) {
            this._shift(dx, dz, 0, ref);
            this._shift(dx, dz, 1, ref);
            this._hasState = true;
        }
        this._origin[0] = ox; this._origin[1] = oz;
        this._live = true;
    }

    /** One substep of LOCAL_FLOW_DT. */
    public substep(ref: Texture): void {
        const ground = this._ground!.colors[0];
        // Advect: velocities -> the other velocities.
        this._run('waterFlowAdvect', WaterFlowAdvectProgram, this._velocities[1 - this._velRead]!,
            [this._velocities[this._velRead]!.colors[0], this._depths[this._depthRead]!.colors[0], ground]);
        this._velRead = 1 - this._velRead;
        // Limit: depths -> the other depths (with each cell's limit).
        this._run('waterFlowLimit', WaterFlowLimitProgram, this._depths[1 - this._depthRead]!,
            [this._depths[this._depthRead]!.colors[0], this._velocities[this._velRead]!.colors[0]]);
        this._depthRead = 1 - this._depthRead;
        // Depth: back again.
        this._run('waterFlowDepth', WaterFlowDepthProgram, this._depths[1 - this._depthRead]!,
            [this._depths[this._depthRead]!.colors[0], this._velocities[this._velRead]!.colors[0], ground]);
        this._depthRead = 1 - this._depthRead;
        // Accelerate.
        this._run('waterFlowAccelerate', WaterFlowAccelerateProgram, this._velocities[1 - this._velRead]!,
            [this._velocities[this._velRead]!.colors[0], this._depths[this._depthRead]!.colors[0], ground, ref]);
        this._velRead = 1 - this._velRead;
    }

    /** What the live waves ride, from the water as it is now. */
    public outputWaves(ref: Texture): void {
        this._run('waterFlowWaves', WaterFlowWavesProgram, this._waves!, this._outInputs(ref));
    }

    /** What the surface draws, from the water as it is now. */
    public outputSurface(ref: Texture): void {
        // It reads no reference (a binding no shader stage uses is not in the layout).
        this._run('waterFlowSurface', WaterFlowSurfaceProgram, this._surface!, this._outInputs(ref).slice(0, 3));
    }

    /** Nothing in reach: the next frame with water starts from the bake. */
    public stop(): void { this._live = false; this._hasState = false; }

    private _outInputs(ref: Texture): Texture[] {
        return [this._depths[this._depthRead]!.colors[0], this._velocities[this._velRead]!.colors[0], this._ground!.colors[0], ref];
    }

    private _uniforms(shift: number[] = [0, 0, 0, 0]): void {
        this._sm.setUniform('u_flowGrid', [this._cells, this._cell, LOCAL_FLOW_DT, 1]);
        this._sm.setUniform('u_flowShift', shift);
    }

    private _run(program: string, reflection: PipelineReflection, target: Framebuffer, textures: Texture[], shift?: number[]): void {
        const pass = this._passes.beginFullscreenPass(target.renderTarget, `water.flow.${program}`, false, undefined, false);
        this._fullscreen.bind(pass, program, reflection, textures);
        this._sm.bind(program);
        this._uniforms(shift);
        this._passes.drawFullscreenAndEnd(pass);
    }

    private _shift(dx: number, dz: number, which: 0 | 1, ref: Texture): void {
        const pair = which === 0 ? this._depths : this._velocities;
        const read = which === 0 ? this._depthRead : this._velRead;
        this._run('waterFlowShift', WaterFlowShiftProgram, pair[1 - read]!, [pair[read]!.colors[0], this._ground!.colors[0], ref], [dx, dz, which, 0]);
        if (which === 0) this._depthRead = 1 - this._depthRead; else this._velRead = 1 - this._velRead;
    }

    /** The ground: each water's grid over the window, the obstacles in it. Cells no grid covers: a bed far above any water. */
    private _groundPass(ox: number, oz: number, side: number, cells: number, waters: readonly LocalFlowWater[],
                        obstacles: Float32Array, count: number, datum: number): void {
        const sm = this._sm;
        const target = this._ground!;
        waters.forEach((w, i) => {
            const pass = this._passes.beginFullscreenPass(target.renderTarget, 'water.flow.ground', i === 0, [1e3, 0, 0.03, -1e3], false);
            this._fullscreen.bind(pass, 'waterFlowGround', WaterFlowGroundProgram, [w.tex0, w.tex1]);
            sm.bind('waterFlowGround');
            sm.setUniform('u_window', [ox, oz, side, cells]);
            sm.setUniform('u_infoOrigin', [w.info.originX, w.info.originZ, w.info.cell, 0]);
            sm.setUniform('u_infoSize', [w.info.nx, w.info.nz, datum, w.manning]);
            sm.setUniform('u_obstacleCount', [count, 0, 0, 0]);
            if (count) sm.setUniform('u_obstacles', obstacles.subarray(0, count * 8));
            this._passes.drawFullscreenAndEnd(pass);
        });
    }

    private _ensureTargets(cells: number): void {
        if (this._ground && this._cells === cells) return;
        this.dispose();
        const state = () => new Framebuffer({
            colorTextureOptions: {
                format: 'rgba32float', unfiltered: true, mipMap: false, wrapping: 'clamp',
                minFilter: 'nearest', magFilter: 'nearest', mipMapFilter: 'nearest',
            }, depth: false,
        }).create(cells, cells);
        const handed = () => new Framebuffer({
            colorTextureOptions: { mipMap: false, precision: 'high', wrapping: 'clamp' }, depth: false,
        }).create(cells, cells);
        this._ground = state();
        this._depths[0] = state(); this._depths[1] = state();
        this._velocities[0] = state(); this._velocities[1] = state();
        this._waves = handed();
        this._surface = handed();
        this._hasState = false;
    }

    public dispose(): void {
        for (const fbo of [this._ground, ...this._depths, ...this._velocities, this._waves, this._surface]) for (const c of fbo?.colors ?? []) c.delete();
        this._ground = null; this._depths[0] = this._depths[1] = null; this._velocities[0] = this._velocities[1] = null;
        this._waves = null; this._surface = null;
        this._live = false; this._hasState = false;
    }
}
