// The virtual-pipe erosion pass (erosion.ts `pipeErosion`) as WebGPU compute, on the engine's device.
// Same equations, same cell units, same step order; results agree with the CPU to float rounding, not
// bit for bit (GPU fma and summation order differ). Only offered when the device has compute.

import { device } from 'cleo/graphics/rhi/deviceHandle';
import { BufferUsage, ShaderStage, TextureUsage } from 'cleo/graphics/rhi/types';
import type { BindGroup, Buffer, ComputePipeline } from 'cleo/graphics/rhi/resources';
import RainProgram from './shaders/pipeRain.wgsl';
import FluxProgram from './shaders/pipeFlux.wgsl';
import WaterProgram from './shaders/pipeWater.wgsl';
import ErodeProgram from './shaders/pipeErode.wgsl';
import TransportProgram from './shaders/pipeTransport.wgsl';
import ReadbackProgram from './shaders/pipeReadback.wgsl';
import { yieldToUi, GenerationCancelled, type GenerateContext } from '../core/generator';
import { cellSize, type PipeMasks, type PipeParams, type WorldFrame } from './erosion';

type Program = typeof RainProgram;

/** Matches the CPU constants in erosion.ts. */
const PIPE_K = 9.81;
const MIN_TILT = 0.05;
/** Rows per readback strip. */
const STRIP = 256;
/** Steps per command buffer: enough to amortise submission, few enough to keep the UI responsive. */
const BATCH = 16;

export function gpuErosionAvailable(): boolean {
  return !!device?.capabilities?.hasCompute;
}

function pipeline(program: Program, label: string): ComputePipeline {
  return device.createComputePipeline({
    label,
    compute: device.createShaderModule({
      label, stage: ShaderStage.COMPUTE, source: program.wgsl, entryPoints: program.entryPoints, resources: program.resources,
    }),
  });
}

function uniformBytes(res: number, p: PipeParams, stripRow = 0, stripRows = 0): Uint8Array {
  const buf = new ArrayBuffer(48);
  const u = new Uint32Array(buf), f = new Float32Array(buf);
  u[0] = res; u[1] = stripRow; u[2] = stripRows; u[3] = 0;
  f[4] = p.dt; f[5] = p.rain; f[6] = Math.max(0, 1 - p.evaporation * p.dt);
  f[7] = p.capacity; f[8] = p.dissolve; f[9] = p.deposit; f[10] = PIPE_K; f[11] = MIN_TILT;
  return new Uint8Array(buf);
}

export async function pipeErosionGpu(h: Float32Array, frame: WorldFrame, p: PipeParams, ctx?: GenerateContext): Promise<PipeMasks> {
  const res = frame.resolution;
  const N = res * res;
  const k = frame.heightScale / cellSize(frame);
  const owned: { destroy(): void }[] = [];
  const buffer = (label: string, bytes: number, init?: Float32Array): Buffer => {
    const b = device.createBuffer({ label, size: bytes, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    owned.push(b);
    device.writeBuffer(b, 0, init ?? new Uint8Array(bytes));
    return b;
  };
  try {
    const cells = new Float32Array(N);
    for (let i = 0; i < N; i++) cells[i] = h[i] * k;
    const uniforms = device.createBuffer({ label: 'pipe.uniforms', size: 48, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    owned.push(uniforms);
    device.writeBuffer(uniforms, 0, uniformBytes(res, p));
    const bed = [buffer('pipe.bedA', N * 4, cells), buffer('pipe.bedB', N * 4, cells)];
    const water = [buffer('pipe.waterA', N * 4), buffer('pipe.waterB', N * 4)];
    const sediment = [buffer('pipe.sedA', N * 4), buffer('pipe.sedB', N * 4)];
    const flux = buffer('pipe.flux', N * 16);
    const velocity = buffer('pipe.velocity', N * 8);
    const flow = buffer('pipe.flow', N * 4);

    const pipes = {
      rain: pipeline(RainProgram, 'pipe.rain'),
      flux: pipeline(FluxProgram, 'pipe.flux'),
      water: pipeline(WaterProgram, 'pipe.water'),
      erode: pipeline(ErodeProgram, 'pipe.erode'),
      transport: pipeline(TransportProgram, 'pipe.transport'),
      readback: pipeline(ReadbackProgram, 'pipe.readback'),
    };
    const group = (pipe: ComputePipeline, label: string, buffers: Buffer[]): BindGroup => device.createBindGroup({
      label, layout: pipe.bindGroupLayouts[0],
      entries: [{ binding: 0, buffer: uniforms }, ...buffers.map((b, i) => ({ binding: i + 1, buffer: b }))],
    });

    // Every buffer pair flips once per step, together, so one parity bit names the whole state:
    // at parity q the current bed / water / sediment are [q], and the step writes [1 - q].
    const groups = [0, 1].map(q => {
      const n = 1 - q;
      return {
        rain: group(pipes.rain, `pipe.rain.${q}`, [water[q]]),
        flux: group(pipes.flux, `pipe.flux.${q}`, [bed[q], water[q], flux]),
        water: group(pipes.water, `pipe.water.${q}`, [flux, water[q], water[n], velocity]),
        erode: group(pipes.erode, `pipe.erode.${q}`, [bed[q], bed[n], sediment[q], water[n], velocity, flow]),
        transport: group(pipes.transport, `pipe.transport.${q}`, [sediment[q], sediment[n], velocity, water[n]]),
      };
    });

    const gx = Math.ceil(res / 8);
    const iterations = Math.max(0, Math.round(p.iterations));
    let q = 0;
    for (let it = 0; it < iterations;) {
      const encoder = device.createCommandEncoder('pipe.batch');
      const end = Math.min(iterations, it + BATCH);
      for (; it < end; it++) {
        const g = groups[q];
        for (const [pipe, bind] of [[pipes.rain, g.rain], [pipes.flux, g.flux], [pipes.water, g.water], [pipes.erode, g.erode], [pipes.transport, g.transport]] as const) {
          const pass = encoder.beginComputePass('pipe');
          pass.setPipeline(pipe);
          pass.setBindGroup(0, bind);
          pass.dispatchWorkgroups(gx, gx, 1);
          pass.end();
        }
        q = 1 - q;
      }
      encoder.finish();
      if (ctx) {
        ctx.progress(it / Math.max(1, iterations), 'Hydraulic erosion (GPU)');
        await yieldToUi();
        if (ctx.cancelled) throw new GenerationCancelled();
      }
    }

    // Read the final state back in strips of rows.
    const stripRows = Math.min(STRIP, res);
    const strip = device.createTexture({
      label: 'pipe.strip', format: 'rgba32float', width: res, height: stripRows,
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.COPY_SRC,
    });
    owned.push(strip);
    const stripView = device.createWholeTextureView(strip);
    const readGroup = device.createBindGroup({
      label: 'pipe.readback', layout: pipes.readback.bindGroupLayouts[0],
      entries: [
        { binding: 0, buffer: uniforms },
        { binding: 1, buffer: bed[q] },
        { binding: 2, buffer: flow },
        { binding: 3, buffer: water[q] },
        { binding: 4, storageTextureView: stripView },
      ],
    });
    const flowOut = new Float32Array(N);
    const waterOut = new Float32Array(N);
    const readView = device.createTextureView(strip);
    for (let row = 0; row < res; row += stripRows) {
      const rows = Math.min(stripRows, res - row);
      device.writeBuffer(uniforms, 0, uniformBytes(res, p, row, rows));
      const encoder = device.createCommandEncoder('pipe.readback');
      const pass = encoder.beginComputePass('pipe.readback');
      pass.setPipeline(pipes.readback);
      pass.setBindGroup(0, readGroup);
      pass.dispatchWorkgroups(gx, Math.ceil(rows / 8), 1);
      pass.end();
      encoder.finish();
      const bytes = await device.readPixels(readView, 0, 0, res, rows);
      const texels = new Float32Array(bytes.buffer, bytes.byteOffset, res * rows * 4);
      for (let r = 0; r < rows; r++) for (let c = 0; c < res; c++) {
        const i = (row + r) * res + c, t = (r * res + c) * 4;
        h[i] = texels[t] / k;
        flowOut[i] = iterations > 0 ? texels[t + 1] / iterations : 0;
        waterOut[i] = texels[t + 2];
      }
    }
    return { flow: flowOut, water: waterOut };
  } finally {
    for (const r of owned) r.destroy();
  }
}
