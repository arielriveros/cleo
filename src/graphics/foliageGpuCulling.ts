/**
 * GPU-driven foliage culling, WebGPU only: per-instance LOD-band and frustum culling in a compute pass,
 * drawn with indirect draws whose instance counts never come back to the CPU.
 *
 * ## The division of labour
 *
 * `Renderer._prepareFoliage` keeps every PER-CELL decision — the distance cull and its hysteresis,
 * admission, the occlusion test, which detail levels a cell straddles, the density prefix — because those
 * are cheap per cell and carry state from frame to frame. Instead of copying the chosen cells' matrices
 * into a buffer on the CPU (the WebGL2 path, `_packFoliageBucket`), it hands each bucket's cell RANGES to
 * {@link FoliageGpuCuller.cull}, and the GPU does the per-INSTANCE half (foliageCull.wgsl): drop each
 * instance faded out of the bucket's band — the vertex stage used to run every vertex of those only to
 * clip them — and each instance whose own bounding sphere is off screen. Survivors are appended to the
 * bucket's vertex buffer of matrices, and foliageCullArgs.wgsl writes the indirect arguments.
 *
 * The instance matrices themselves are uploaded ONCE per layer version (a brush stroke), not per frame:
 * what changes per frame is a few bytes of ranges and parameters per bucket.
 *
 * ## Bounded draws
 *
 * A bucket is drawn in fixed-capacity SEGMENTS — one indirect draw per segment per sub-model, the
 * segment's matrices reached through the vertex-buffer offset — sized by the same triangle budget as the
 * CPU path's chunks (`foliageChunkLimit`). One draw must stay bounded: an unbounded submission of a heavy
 * tree is a TDR and a removed device.
 *
 * ## Ordering
 *
 * The compute pass is recorded into the frame's encoder before the geometry pass, so it runs first. The
 * per-bucket parameters and ranges go up with `writeBuffer`, which lands before the frame is submitted —
 * once per bucket per frame, so {@link FoliageGpuCuller.cull} must run at most once per layer per frame
 * (the renderer keeps captures and second views on the CPU path). The counters are cleared by the args
 * pass itself, after it has read them, so no write has to be ordered against an unsubmitted dispatch.
 */

import FoliageCullProgram from './shaders/wgsl/foliageCull.wgsl';
import FoliageCullArgsProgram from './shaders/wgsl/foliageCullArgs.wgsl';
import { device } from './rhi/deviceHandle';
import { BufferUsage, ShaderStage } from './rhi/types';
import type { Buffer as RhiBuffer, BindGroup, ComputePipeline } from './rhi/resources';
import type { CommandEncoder } from './rhi/device';
import type { Mesh } from './mesh';
import type { Model } from './model';
import {
    createFoliageBatch, foliageChunkLimit, type FoliageBatch, type FoliageCell, type FoliageLayer,
} from '../terrain/foliage';

/** One bucket's crossfade band (`foliageLodBands`), or null when it has none. */
export interface GpuCullBand { inStart: number; inEnd: number; outStart: number; outEnd: number }

/** What one draw bucket gives the culler for a frame. */
export interface GpuCullBucket {
    cells: readonly FoliageCell[];
    /** The bucket's sub-models: one indirect draw each per segment. */
    models: readonly Model[];
    band: GpuCullBand | null;
    /** The density prefix fraction (`foliageKeepFraction`), 1 = every instance. */
    keep: number;
    /** The bucket prototype's bounding sphere in model space. */
    sphere: readonly [number, number, number, number];
}

/** A draw segment: a {@link FoliageBatch} the draw code can treat like any other, drawn indirectly. */
export interface GpuFoliageSegment extends FoliageBatch {
    indirect: {
        args: RhiBuffer;
        /** Byte offset of each sub-model's argument record. */
        offsets: Map<Mesh, number>;
        /** Byte offset of the segment's first matrix in `buffer`. */
        vertexOffset: number;
    };
}

/** Bytes per instance matrix, and per indirect argument record (5 u32). */
const MATRIX_BYTES = 64;
const ARGS_BYTES = 20;
/** CullParams: 6 planes + eye + band + sphere (vec4s) + counts (vec4<u32>). */
const PARAMS_BYTES = 10 * 16;

interface BucketGpu {
    params: RhiBuffer;
    ranges: RhiBuffer | null;
    rangeCapacity: number;
    visible: RhiBuffer | null;
    visibleCapacity: number;
    group: BindGroup | null;
}

interface LayerGpu {
    version: number;
    instances: RhiBuffer | null;
    instanceCapacity: number;
    /** First instance of each cell in `instances`. */
    cellStart: Uint32Array;
    counters: RhiBuffer;
    buckets: BucketGpu[];
    // The indirect argument layout, rebuilt when the buckets' models or segment sizes change.
    layoutKey: string;
    args: RhiBuffer | null;
    records: RhiBuffer | null;
    argsInfo: RhiBuffer;
    argsGroup: BindGroup | null;
    recordCount: number;
    segments: GpuFoliageSegment[][];
    /** The segments drawn this frame, per bucket: a prefix of `segments`. */
    drawn: GpuFoliageSegment[][];
}

const EMPTY: GpuFoliageSegment[] = [];

/** The ceiling of buckets a layer can have: detail levels plus the impostor. */
const MAX_BUCKETS = 16;

export class FoliageGpuCuller {
    private _cull: ComputePipeline | null = null;
    private _args: ComputePipeline | null = null;
    private readonly _layers = new WeakMap<FoliageLayer, LayerGpu>();
    private readonly _params = new ArrayBuffer(PARAMS_BYTES);
    private readonly _paramsF = new Float32Array(this._params);
    private readonly _paramsU = new Uint32Array(this._params);
    private _rangeScratch = new Uint32Array(0);

    /** Whether this device can cull on the GPU at all: compute AND indirect draws. */
    public static get supported(): boolean {
        return device.capabilities.hasCompute && device.capabilities.hasIndirectDraw === true;
    }

    private _pipelines(): { cull: ComputePipeline; args: ComputePipeline } {
        if (!this._cull || !this._args) {
            const module = (label: string, program: typeof FoliageCullProgram) => device.createShaderModule({
                label, stage: ShaderStage.COMPUTE, source: program.wgsl,
                entryPoints: program.entryPoints, resources: program.resources,
            });
            this._cull = device.createComputePipeline({ label: 'foliageCull', compute: module('foliageCull', FoliageCullProgram) });
            this._args = device.createComputePipeline({ label: 'foliageCullArgs', compute: module('foliageCullArgs', FoliageCullArgsProgram) });
        }
        return { cull: this._cull, args: this._args };
    }

    /**
     * Cull every bucket of `layer` for this frame and return each bucket's draw segments. `planes` is the
     * camera frustum (Frustum.planes), `eye` the camera position.
     */
    public cull(encoder: CommandEncoder, layer: FoliageLayer, buckets: readonly GpuCullBucket[],
                planes: ArrayLike<number>, eye: ArrayLike<number>): GpuFoliageSegment[][] {
        const { cull, args } = this._pipelines();
        const state = this._state(layer, buckets.length);
        this._syncInstances(layer, state);
        this._ensureVisible(layer, state);
        this._syncLayout(layer, state, buckets);

        const pass = encoder.beginComputePass('foliage.cull');
        pass.setPipeline(cull);
        // Per layer: the renderer keeps each layer's list until the layer is drawn.
        const drawn = state.drawn;
        drawn.length = buckets.length;
        for (let b = 0; b < buckets.length; b++) {
            const bucket = buckets[b], gpu = state.buckets[b];
            const total = this._writeRanges(layer, state, gpu, bucket);
            // Only the segments this many survivors could reach are drawn. Every segment has an argument
            // record, but a 400k-triangle tree's tiny segments, all drawn empty, were 250 draw calls.
            const all = state.segments[b] ?? [];
            const cap = all[0]?.capacity ?? 1;
            drawn[b] = total === 0 ? EMPTY : all.slice(0, Math.min(all.length, Math.ceil(total / cap)));
            if (total === 0) continue;
            this._writeParams(gpu, bucket, planes, eye, b, total);
            if (!gpu.group) {
                gpu.group = device.createBindGroup({
                    label: 'foliageCull',
                    layout: cull.bindGroupLayouts[0],
                    entries: [
                        { binding: 0, buffer: gpu.params },
                        { binding: 1, buffer: state.instances! },
                        { binding: 2, buffer: gpu.ranges! },
                        { binding: 3, buffer: gpu.visible! },
                        { binding: 4, buffer: state.counters },
                    ],
                });
            }
            pass.setBindGroup(0, gpu.group);
            const groups = Math.ceil(total / 64);
            const x = Math.min(groups, 65535);
            pass.dispatchWorkgroups(x, Math.ceil(groups / x));
        }
        // Always, even with nothing culled: it is also what clears the counters.
        pass.setPipeline(args);
        pass.setBindGroup(0, state.argsGroup!);
        pass.dispatchWorkgroups(1);
        pass.end();
        return drawn;
    }

    /** Free a layer's GPU state (the layer is gone, or the GPU path was switched off). */
    public release(layer: FoliageLayer): void {
        const state = this._layers.get(layer);
        if (!state) return;
        this._layers.delete(layer);
        state.instances?.destroy();
        state.counters.destroy();
        state.args?.destroy();
        state.records?.destroy();
        state.argsInfo.destroy();
        for (const b of state.buckets) { b.params.destroy(); b.ranges?.destroy(); b.visible?.destroy(); }
    }

    private _state(layer: FoliageLayer, bucketCount: number): LayerGpu {
        let state = this._layers.get(layer);
        if (!state) {
            state = {
                version: -1, instances: null, instanceCapacity: 0, cellStart: new Uint32Array(0),
                counters: device.createBuffer({ label: 'foliageCull.counters', size: MAX_BUCKETS * 4,
                                                usage: BufferUsage.STORAGE | BufferUsage.COPY_DST }),
                buckets: [], layoutKey: '', args: null, records: null, recordCount: 0, segments: [],
                argsInfo: device.createBuffer({ label: 'foliageCull.argsInfo', size: 16,
                                                usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }),
                argsGroup: null, drawn: [],
            };
            this._layers.set(layer, state);
        }
        while (state.buckets.length < bucketCount) {
            state.buckets.push({
                params: device.createBuffer({ label: 'foliageCull.params', size: PARAMS_BYTES,
                                              usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }),
                ranges: null, rangeCapacity: 0, visible: null, visibleCapacity: 0, group: null,
            });
        }
        return state;
    }

    /** Upload every cell's matrices, back to back, when the layer's instances changed. */
    private _syncInstances(layer: FoliageLayer, state: LayerGpu): void {
        if (state.version === layer.version && state.instances) return;
        state.version = layer.version;
        const cells = layer.cells;
        const cellStart = new Uint32Array(cells.length);
        let total = 0;
        for (let i = 0; i < cells.length; i++) { cellStart[i] = total; total += cells[i].count; }
        state.cellStart = cellStart;
        const data = new Float32Array(Math.max(1, total) * 16);
        for (let i = 0; i < cells.length; i++) data.set(cells[i].matrices.subarray(0, cells[i].count * 16), cellStart[i] * 16);
        if (!state.instances || state.instanceCapacity < total) {
            state.instances?.destroy();
            state.instanceCapacity = Math.max(total, 1);
            state.instances = device.createBuffer({ label: 'foliageCull.instances', size: state.instanceCapacity * MATRIX_BYTES,
                                                    usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
            for (const b of state.buckets) b.group = null;
        }
        device.writeBuffer(state.instances, 0, data);
    }

    /** Every bucket's output buffer, able to hold every instance of the layer. */
    private _ensureVisible(layer: FoliageLayer, state: LayerGpu): void {
        const total = Math.max(1, layer.count);
        for (const b of state.buckets) {
            if (b.visible && b.visibleCapacity >= total) continue;
            b.visible?.destroy();
            b.visibleCapacity = total;
            b.visible = device.createBuffer({ label: 'foliageCull.visible', size: total * MATRIX_BYTES,
                                              usage: BufferUsage.STORAGE | BufferUsage.VERTEX });
            b.group = null;
            state.layoutKey = '';   // the segments point at the old buffer
        }
    }

    /**
     * The indirect argument records — one per (bucket, segment, sub-model) — and the segments that draw
     * from them. Rebuilt only when a bucket's models or the layer's size change.
     */
    private _syncLayout(layer: FoliageLayer, state: LayerGpu, buckets: readonly GpuCullBucket[]): void {
        const total = Math.max(1, layer.count);
        const caps = buckets.map(b => foliageChunkLimit(Math.max(0, ...b.models.map(m => m.mesh.activeIndexCount / 3))));
        const key = buckets.map((b, i) => `${caps[i]}:${b.models.map(m => `${meshId(m.mesh)}/${m.mesh.activeIndexCount}`).join(',')}`)
            .join('|') + `#${total}`;
        if (key === state.layoutKey && state.args) return;
        state.layoutKey = key;

        const records: number[] = [], argsInit: number[] = [];
        const segments: GpuFoliageSegment[][] = [];
        for (let b = 0; b < buckets.length; b++) {
            const list: GpuFoliageSegment[] = [];
            const cap = caps[b];
            for (let start = 0; start < total; start += cap) {
                const offsets = new Map<Mesh, number>();
                for (const model of buckets[b].models) {
                    offsets.set(model.mesh, (records.length / 4) * ARGS_BYTES);
                    records.push(b, start, cap, 0);
                    argsInit.push(model.mesh.activeIndexCount, 0, 0, 0, 0);
                }
                list.push(Object.assign(createFoliageBatch(), {
                    buffer: state.buckets[b].visible,
                    // A placeholder the draw loops read as "not empty": the real count is on the GPU.
                    count: cap, capacity: cap,
                    indirect: { args: null as unknown as RhiBuffer, offsets, vertexOffset: start * MATRIX_BYTES },
                }));
            }
            segments.push(list);
        }

        state.args?.destroy();
        state.records?.destroy();
        state.recordCount = records.length / 4;
        state.args = device.createBuffer({ label: 'foliageCull.args', size: Math.max(1, argsInit.length) * 4,
                                           usage: BufferUsage.INDIRECT | BufferUsage.STORAGE | BufferUsage.COPY_DST });
        device.writeBuffer(state.args, 0, new Uint32Array(argsInit));
        state.records = device.createBuffer({ label: 'foliageCull.records', size: Math.max(1, records.length) * 4,
                                              usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
        device.writeBuffer(state.records, 0, new Uint32Array(records));
        device.writeBuffer(state.argsInfo, 0, new Uint32Array([state.recordCount, 0, 0, 0]));
        for (const list of segments) for (const s of list) s.indirect.args = state.args;
        state.segments = segments;
        state.argsGroup = device.createBindGroup({
            label: 'foliageCullArgs',
            layout: this._pipelines().args.bindGroupLayouts[0],
            entries: [
                { binding: 0, buffer: state.argsInfo },
                { binding: 1, buffer: state.records },
                { binding: 2, buffer: state.counters },
                { binding: 3, buffer: state.args },
            ],
        });
    }

    /** The bucket's cells as instance ranges with their running prefix. Returns the instances to test. */
    private _writeRanges(layer: FoliageLayer, state: LayerGpu, gpu: BucketGpu, bucket: GpuCullBucket): number {
        const cells = bucket.cells;
        if (cells.length === 0) return 0;
        if (this._rangeScratch.length < cells.length * 4) this._rangeScratch = new Uint32Array(cells.length * 8);
        const r = this._rangeScratch;
        let total = 0;
        for (let i = 0; i < cells.length; i++) {
            const c = cells[i];
            // The density PREFIX, exactly as packFoliageInstances takes it, so a thinned instance stays
            // thinned at every level and in the shadow pass.
            const take = bucket.keep >= 1 ? c.count : Math.min(c.count, Math.ceil(c.count * bucket.keep));
            r[i * 4] = state.cellStart[c.index];
            r[i * 4 + 1] = take;
            r[i * 4 + 2] = total;
            r[i * 4 + 3] = 0;
            total += take;
        }
        if (!gpu.ranges || gpu.rangeCapacity < cells.length) {
            gpu.ranges?.destroy();
            gpu.rangeCapacity = Math.max(cells.length, layer.cells.length);
            gpu.ranges = device.createBuffer({ label: 'foliageCull.ranges', size: gpu.rangeCapacity * 16,
                                               usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
            gpu.group = null;
        }
        device.writeBuffer(gpu.ranges, 0, r.subarray(0, cells.length * 4));
        return total;
    }

    private _writeParams(gpu: BucketGpu, bucket: GpuCullBucket, planes: ArrayLike<number>, eye: ArrayLike<number>,
                         index: number, total: number): void {
        const f = this._paramsF, u = this._paramsU;
        for (let i = 0; i < 24; i++) f[i] = planes[i];
        f[24] = eye[0]; f[25] = eye[1]; f[26] = eye[2]; f[27] = bucket.band ? 1 : 0;
        const band = bucket.band;
        f[28] = band?.inStart ?? 0; f[29] = band?.inEnd ?? 0; f[30] = band?.outStart ?? 0; f[31] = band?.outEnd ?? 0;
        f[32] = bucket.sphere[0]; f[33] = bucket.sphere[1]; f[34] = bucket.sphere[2]; f[35] = bucket.sphere[3];
        u[36] = bucket.cells.length; u[37] = total; u[38] = index; u[39] = 0;
        device.writeBuffer(gpu.params, 0, new Uint8Array(this._params));
    }
}

/** A stable identity for a mesh, for the layout key. */
const meshIds = new WeakMap<Mesh, number>();
let nextMeshId = 0;
function meshId(mesh: Mesh): number {
    let id = meshIds.get(mesh);
    if (id === undefined) { id = ++nextMeshId; meshIds.set(mesh, id); }
    return id;
}
