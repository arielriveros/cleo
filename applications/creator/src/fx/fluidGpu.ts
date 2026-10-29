// FX Creator's gas solver on the GPU: the steps of fluidCpu.ts as WebGPU compute kernels, dispatched
// through the engine's own RHI device -- the same device the viewport renders with. Only available when
// `device.capabilities.hasCompute` (the WebGPU backend); on WebGL2 the app falls back to the CPU solver.
//
// Per step, one command encoder: sources -> curl -> confine -> advect (A -> B) -> divergence ->
// Jacobi x N (ping-pong) -> project+dissipate, and the A/B roles swap. Uniform writes are queued ahead
// of the encoder, so everything inside one step reads one set of uniforms; a frame's render is its own
// encoder followed by a readback of the tile.

import { device } from 'cleo/graphics/rhi/deviceHandle';
import { BufferUsage, ShaderStage, TextureUsage } from 'cleo/graphics/rhi/types';
import type { BindGroup, Buffer, ComputePipeline, Texture } from 'cleo/graphics/rhi/resources';
import SourcesProgram from './shaders/fxSources.wgsl';
import CurlProgram from './shaders/fxCurl.wgsl';
import ConfineProgram from './shaders/fxConfine.wgsl';
import AdvectProgram from './shaders/fxAdvect.wgsl';
import DivergenceProgram from './shaders/fxDivergence.wgsl';
import JacobiProgram from './shaders/fxJacobi.wgsl';
import ProjectProgram from './shaders/fxProject.wgsl';
import LightProgram from './shaders/fxLight.wgsl';
import RenderProgram from './shaders/fxRender.wgsl';
import type { FluidDims } from './fluidCpu';
import type { FluidBackend } from './generateFx';
import type { FxParams } from './fxParams';
import { FIRE_OPACITY, lightVector, RENDER_STEP, viewBasis } from './volumeRender';

type Program = typeof SourcesProgram;

/** Whether the engine's device can run this solver. */
export function gpuFluidAvailable(): boolean {
  return !!device?.capabilities?.hasCompute;
}

const UNIFORM_BYTES = 15 * 16;

function pipeline(program: Program, label: string): ComputePipeline {
  const module = device.createShaderModule({
    label,
    stage: ShaderStage.COMPUTE,
    source: program.wgsl,
    entryPoints: program.entryPoints,
    resources: program.resources,
  });
  return device.createComputePipeline({ label, compute: module });
}

/** Pack the uniform block of fxCommon.wgsl. */
function packUniforms(p: FxParams, dims: FluidDims, dt: number, time: number, steps: number, tile: number): ArrayBuffer {
  const buf = new ArrayBuffer(UNIFORM_BYTES);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  const set = (row: number, a: number, b: number, c: number, d: number) => { f[row * 4] = a; f[row * 4 + 1] = b; f[row * 4 + 2] = c; f[row * 4 + 3] = d; };
  u[0] = dims.nx; u[1] = dims.ny; u[2] = dims.nz; u[3] = p.seed >>> 0;
  set(1, (dims.nx - 1) / 2, p.emitterHeight * (dims.ny - 1), (dims.nz - 1) / 2, Math.max(1, p.emitterRadius * dims.nx));
  set(2, p.fuel, p.heat, p.smoke, p.emitSpeed);
  set(3, p.turbulence, p.turbulenceScale / dims.nx, steps * 0.05, p.emitterShape === 'disc' ? 1 : 0);
  set(4, p.ignition, p.burnRate, p.heatRelease, p.smokeYield);
  set(5, p.buoyancy, p.weight, p.vorticity, p.wind);
  set(6, Math.max(0, 1 - p.cooling * dt), Math.max(0, 1 - p.smokeDissipation * dt), Math.max(0, 1 - p.velocityDamping * dt), dt);
  set(7, p.emitDuration <= 0 || time < p.emitDuration ? 1 : 0, p.absorption, p.emission, p.emissionRange);
  set(8, p.smokeColor[0], p.smokeColor[1], p.smokeColor[2], p.ambient);
  const L = lightVector(p);
  set(9, L[0], L[1], L[2], FIRE_OPACITY);
  const b = viewBasis(dims, p.view, p.yaw);
  set(10, b.dir[0], b.dir[1], b.dir[2], b.half);
  set(11, b.right[0], b.right[1], b.right[2], Math.hypot(dims.nx - 1, dims.ny - 1, dims.nz - 1));
  set(12, b.up[0], b.up[1], b.up[2], tile);
  set(13, b.center[0], b.center[1], b.center[2], RENDER_STEP);
  u[56] = Math.ceil(dims.nx / 2); u[57] = Math.ceil(dims.ny / 2); u[58] = Math.ceil(dims.nz / 2); u[59] = 0;
  return buf;
}

export function gpuBackend(dims: FluidDims): FluidBackend {
  const cells = dims.nx * dims.ny * dims.nz;
  const lightCells = Math.ceil(dims.nx / 2) * Math.ceil(dims.ny / 2) * Math.ceil(dims.nz / 2);
  const owned: { destroy(): void }[] = [];
  const storage = (label: string, bytes: number): Buffer => {
    const b = device.createBuffer({ label, size: bytes, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    owned.push(b);
    // Zeroed explicitly: WebGPU does zero new buffers, but saying so costs nothing and documents intent.
    device.writeBuffer(b, 0, new Uint8Array(bytes));
    return b;
  };
  const uniforms = device.createBuffer({ label: 'fx.uniforms', size: UNIFORM_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
  owned.push(uniforms);
  const vel = [storage('fx.velA', cells * 16), storage('fx.velB', cells * 16)];
  const sca = [storage('fx.scaA', cells * 16), storage('fx.scaB', cells * 16)];
  const curl = storage('fx.curl', cells * 16);
  const divergence = storage('fx.div', cells * 4);
  const pressure = [storage('fx.pA', cells * 4), storage('fx.pB', cells * 4)];
  const light = storage('fx.light', lightCells * 4);
  const lut = storage('fx.lut', 256 * 16);

  const pipes = {
    sources: pipeline(SourcesProgram, 'fx.sources'),
    curl: pipeline(CurlProgram, 'fx.curl'),
    confine: pipeline(ConfineProgram, 'fx.confine'),
    advect: pipeline(AdvectProgram, 'fx.advect'),
    divergence: pipeline(DivergenceProgram, 'fx.divergence'),
    jacobi: pipeline(JacobiProgram, 'fx.jacobi'),
    project: pipeline(ProjectProgram, 'fx.project'),
    light: pipeline(LightProgram, 'fx.light'),
    render: pipeline(RenderProgram, 'fx.render'),
  };
  const group = (pipe: ComputePipeline, label: string, buffers: Buffer[]): BindGroup =>
    device.createBindGroup({
      label,
      layout: pipe.bindGroupLayouts[0],
      entries: [{ binding: 0, buffer: uniforms }, ...buffers.map((buffer, i) => ({ binding: i + 1, buffer }))],
    });

  // Two parities: `cur` is the buffer pair holding the current state. Advect reads cur, writes 1 - cur.
  const groups = [0, 1].map(cur => {
    const nxt = 1 - cur;
    return {
      sources: group(pipes.sources, `fx.sources.${cur}`, [vel[cur], sca[cur]]),
      curl: group(pipes.curl, `fx.curl.${cur}`, [vel[cur], curl]),
      confine: group(pipes.confine, `fx.confine.${cur}`, [curl, vel[cur]]),
      advect: group(pipes.advect, `fx.advect.${cur}`, [vel[cur], sca[cur], vel[nxt], sca[nxt]]),
      divergence: group(pipes.divergence, `fx.div.${cur}`, [vel[nxt], divergence, pressure[0]]),
      project: [0, 1].map(pp => group(pipes.project, `fx.project.${cur}.${pp}`, [pressure[pp], vel[nxt], sca[nxt]])),
      light: group(pipes.light, `fx.light.${cur}`, [sca[cur], light]),
    };
  });
  const jacobi = [0, 1].map(pp => group(pipes.jacobi, `fx.jacobi.${pp}`, [divergence, pressure[pp], pressure[1 - pp]]));

  let tileTexture: Texture | null = null;
  let tileSize = 0;
  let renderGroups: BindGroup[] = [];
  let cur = 0;
  let time = 0;
  let steps = 0;
  let lutUploaded: Float32Array | null = null;

  const wg = (n: number) => Math.ceil(n / 4);

  return {
    kind: 'gpu',
    dims,
    step(p, dt) {
      device.writeBuffer(uniforms, 0, new Uint8Array(packUniforms(p, dims, dt, time, steps, tileSize)));
      const g = groups[cur];
      const encoder = device.createCommandEncoder('fx.step');
      const dispatch = (pipe: ComputePipeline, bind: BindGroup, label: string) => {
        const pass = encoder.beginComputePass(label);
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(wg(dims.nx), wg(dims.ny), wg(dims.nz));
        pass.end();
      };
      dispatch(pipes.sources, g.sources, 'fx.sources');
      if (p.vorticity > 0) {
        dispatch(pipes.curl, g.curl, 'fx.curl');
        dispatch(pipes.confine, g.confine, 'fx.confine');
      }
      dispatch(pipes.advect, g.advect, 'fx.advect');
      dispatch(pipes.divergence, g.divergence, 'fx.divergence');
      let pp = 0;
      for (let it = 0; it < p.pressureIterations; it++) {
        dispatch(pipes.jacobi, jacobi[pp], 'fx.jacobi');
        pp = 1 - pp;
      }
      dispatch(pipes.project, g.project[pp], 'fx.project');
      encoder.finish();
      cur = 1 - cur;
      time += dt;
      steps++;
    },
    async render(p, tile, lutData) {
      if (lutUploaded !== lutData) { device.writeBuffer(lut, 0, lutData); lutUploaded = lutData; }
      if (!tileTexture || tileSize !== tile) {
        tileTexture?.destroy();
        tileTexture = device.createTexture({
          label: 'fx.tile', format: 'rgba8unorm', width: tile, height: tile,
          usage: TextureUsage.STORAGE_BINDING | TextureUsage.COPY_SRC,
        });
        tileSize = tile;
        const view = device.createWholeTextureView(tileTexture);
        renderGroups = [0, 1].map(c => device.createBindGroup({
          label: `fx.render.${c}`,
          layout: pipes.render.bindGroupLayouts[0],
          entries: [
            { binding: 0, buffer: uniforms },
            { binding: 1, buffer: sca[c] },
            { binding: 2, buffer: light },
            { binding: 3, buffer: lut },
            { binding: 4, storageTextureView: view },
          ],
        }));
      }
      // The tile size and camera live in the uniform block too; rewrite it for this frame.
      device.writeBuffer(uniforms, 0, new Uint8Array(packUniforms(p, dims, 0, time, steps, tile)));
      const encoder = device.createCommandEncoder('fx.render');
      const lightPass = encoder.beginComputePass('fx.light');
      lightPass.setPipeline(pipes.light);
      lightPass.setBindGroup(0, groups[cur].light);
      lightPass.dispatchWorkgroups(wg(Math.ceil(dims.nx / 2)), wg(Math.ceil(dims.ny / 2)), wg(Math.ceil(dims.nz / 2)));
      lightPass.end();
      const pass = encoder.beginComputePass('fx.render');
      pass.setPipeline(pipes.render);
      pass.setBindGroup(0, renderGroups[cur]);
      pass.dispatchWorkgroups(Math.ceil(tile / 8), Math.ceil(tile / 8), 1);
      pass.end();
      encoder.finish();
      return device.readPixels(device.createTextureView(tileTexture), 0, 0, tile, tile);
    },
    dispose() {
      tileTexture?.destroy();
      for (const r of owned) r.destroy();
    },
  };
}
