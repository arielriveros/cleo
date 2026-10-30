// FX Creator's gas solver on the GPU: the steps of fluidCpu.ts as WebGPU compute kernels, dispatched
// through the engine's own RHI device -- the same device the viewport renders with. Only available when
// `device.capabilities.hasCompute` (the WebGPU backend); on WebGL2 the app falls back to the CPU solver.
//
// Per step, one command encoder: sources -> curl -> confine -> advect (A -> B) [-> MacCormack back,
// correct] -> divergence -> pressure (Jacobi ping-pong, or red-black SOR in place) -> project+dissipate,
// and the A/B roles swap. Uniform writes are queued ahead of the encoder, so everything inside one step
// reads one set of uniforms; a frame's render is its own encoder followed by a readback of the tile.

import { device } from 'cleo/graphics/rhi/deviceHandle';
import { BufferUsage, ShaderStage, TextureUsage } from 'cleo/graphics/rhi/types';
import type { BindGroup, Buffer, ComputePipeline, Texture } from 'cleo/graphics/rhi/resources';
import type { Texture as EngineTexture } from 'cleo/graphics/texture';
import SourcesProgram from './shaders/fxSources.wgsl';
import CurlProgram from './shaders/fxCurl.wgsl';
import ConfineProgram from './shaders/fxConfine.wgsl';
import AdvectProgram from './shaders/fxAdvect.wgsl';
import McBackProgram from './shaders/fxMcBack.wgsl';
import McCorrectProgram from './shaders/fxMcCorrect.wgsl';
import DivergenceProgram from './shaders/fxDivergence.wgsl';
import JacobiProgram from './shaders/fxJacobi.wgsl';
import JacobiRBProgram from './shaders/fxJacobiRB.wgsl';
import ProjectProgram from './shaders/fxProject.wgsl';
import LightProgram from './shaders/fxLight.wgsl';
import RenderProgram from './shaders/fxRender.wgsl';
import PackProgram from './shaders/fxPack.wgsl';
import OccupancyProgram from './shaders/fxOccupancy.wgsl';
import DetailProgram from './shaders/fxDetail.wgsl';
import DetailPackProgram from './shaders/fxDetailPack.wgsl';
import ShadowProgram from './shaders/fxShadow.wgsl';
import ReduceProgram from './shaders/fxReduce.wgsl';
import { SOR_OMEGA, type FluidDims, type SceneWind } from './fluidCpu';
import type { FluidBackend } from './generateFx';
import type { FxParams } from './fxParams';
import { FIRE_OPACITY, lightVector, RENDER_STEP, viewBasis } from './volumeRender';
import { DETAIL_PERIOD, detailBlend, detailPhase, stepFactors } from './realism';

type Program = typeof SourcesProgram;

/** Whether the engine's device can run this solver. */
export function gpuFluidAvailable(): boolean {
  return !!device?.capabilities?.hasCompute;
}

const UNIFORM_BYTES = 26 * 16;

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

/** What the uniform block carries beyond the parameters: the preview stage, if any. */
interface StageState { wind: SceneWind | null; solids: boolean }

/** Pack the uniform block of fxCommon.wgsl. `resets` says which detail coordinate sets go back to rest this step. */
function packUniforms(p: FxParams, dims: FluidDims, dt: number, time: number, steps: number, tile: number, stage: StageState,
                      resets: [boolean, boolean] = [false, false]): ArrayBuffer {
  const buf = new ArrayBuffer(UNIFORM_BYTES);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  const set = (row: number, a: number, b: number, c: number, d: number) => { f[row * 4] = a; f[row * 4 + 1] = b; f[row * 4 + 2] = c; f[row * 4 + 3] = d; };
  u[0] = dims.nx; u[1] = dims.ny; u[2] = dims.nz; u[3] = p.seed >>> 0;
  set(1, (p.emitterX ?? 0.5) * (dims.nx - 1), p.emitterHeight * (dims.ny - 1), (p.emitterZ ?? 0.5) * (dims.nz - 1), Math.max(1, p.emitterRadius * dims.nx));
  set(2, p.fuel, p.heat, p.smoke, p.emitSpeed);
  set(3, p.turbulence, p.turbulenceScale / dims.nx, steps * 0.05, p.emitterShape === 'disc' ? 1 : 0);
  set(4, p.ignition, p.burnRate, p.heatRelease, p.smokeYield);
  const k = stepFactors(p, time, dt);
  set(5, p.buoyancy, p.weight, p.vorticity * k.vortScale, p.wind);
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
  set(15, p.emitterNoise ?? 0, p.expansion ?? 0, time, p.pressureSolver === 'sor' ? SOR_OMEGA : 0);
  const w = stage.wind;
  set(16, w?.vx ?? 0, w?.vz ?? 0, w?.gustiness ?? 0, w?.gustScale ?? 1);
  set(17, w?.gustSpeed ?? 0, w ? 1 : 0, stage.solids ? 1 : 0, p.advection === 'maccormack' ? 1 : 0);
  set(18, p.anisotropy ?? 0, p.scatterOctaves ?? 1, p.fireGlow ?? 0, p.detailStrength ?? 0);
  set(19, p.detailScale ?? 6, 0, 0, 0);
  set(20, p.boundaries === 'open' ? 1 : 0, p.disturbance ?? 0, k.disturbanceCell, k.disturbancePhase);
  // Diffusion as the per-step Laplacian weight, held below the explicit scheme's stability limit.
  set(21, p.shredding ?? 0, (p.diffusion ?? 0) > 0 ? Math.min(1 / 6.5, p.diffusion * dt * 60) : 0, k.flameKeep, p.coolingT4 ?? 0);
  set(22, k.flicker, p.condensation ?? 0, p.dewPoint ?? 0.35, k.settle);
  set(23, k.blast, p.groundDrag ?? 0, p.albedo ?? 1, p.powder ?? 0);
  set(24, p.flameShape ?? 0, p.fireIntensity ?? 1, p.skyOcclusion ?? 0, 0);
  set(25, resets[0] ? 1 : 0, resets[1] ? 1 : 0, detailBlend(time), 0);
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
  // The red-black colour, one tiny uniform per colour: a dispatch picks its colour by bind group.
  const colours = [0, 1].map(c => {
    const b = device.createBuffer({ label: `fx.colour.${c}`, size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    owned.push(b);
    device.writeBuffer(b, 0, new Uint8Array(new Uint32Array([c, 0, 0, 0]).buffer));
    return b;
  });
  const vel = [storage('fx.velA', cells * 16), storage('fx.velB', cells * 16)];
  const sca = [storage('fx.scaA', cells * 16), storage('fx.scaB', cells * 16)];
  const curl = storage('fx.curl', cells * 16);
  const divergence = storage('fx.div', cells * 4);
  const pressure = [storage('fx.pA', cells * 4), storage('fx.pB', cells * 4)];
  const light = storage('fx.light', lightCells * 4);
  const glow = storage('fx.glow', lightCells * 4);
  const lut = storage('fx.lut', 256 * 16);
  const solid = storage('fx.solid', cells * 4);
  const burned = storage('fx.burned', cells * 4);
  const back = storage('fx.mcBack', cells * 16);
  // Advected detail coordinates: two sets, ping-ponged, each starting on the rest grid (full-res voxels).
  const restCoords = new Float32Array(lightCells * 4);
  {
    const lx = Math.ceil(dims.nx / 2), ly = Math.ceil(dims.ny / 2);
    for (let i = 0; i < lightCells; i++) {
      const x = i % lx, y = Math.floor(i / lx) % ly, z = Math.floor(i / (lx * ly));
      restCoords.set([x * 2, y * 2, z * 2, 1], i * 4);
    }
  }
  const coordBuffer = (label: string) => { const b = storage(label, lightCells * 16); device.writeBuffer(b, 0, new Uint8Array(restCoords.buffer)); return b; };
  const detailA = [coordBuffer('fx.detailA0'), coordBuffer('fx.detailA1')];
  const detailB = [coordBuffer('fx.detailB0'), coordBuffer('fx.detailB1')];
  let detailCur = 0;
  const brickCount = Math.ceil(dims.nx / 8) * Math.ceil(dims.ny / 8) * Math.ceil(dims.nz / 8);
  const bricksum = storage('fx.bricksum', brickCount * 16);
  // The fire light's centroid and strength, 1x1, read back without waiting (see fireLight()).
  const fireTexture = device.createTexture({
    label: 'fx.fireLight', format: 'rgba8unorm', width: 1, height: 1,
    usage: TextureUsage.STORAGE_BINDING | TextureUsage.COPY_SRC,
  });
  owned.push(fireTexture);

  const pipes = {
    sources: pipeline(SourcesProgram, 'fx.sources'),
    curl: pipeline(CurlProgram, 'fx.curl'),
    confine: pipeline(ConfineProgram, 'fx.confine'),
    advect: pipeline(AdvectProgram, 'fx.advect'),
    mcBack: pipeline(McBackProgram, 'fx.mcBack'),
    mcCorrect: pipeline(McCorrectProgram, 'fx.mcCorrect'),
    divergence: pipeline(DivergenceProgram, 'fx.divergence'),
    jacobi: pipeline(JacobiProgram, 'fx.jacobi'),
    jacobiRB: pipeline(JacobiRBProgram, 'fx.jacobiRB'),
    project: pipeline(ProjectProgram, 'fx.project'),
    light: pipeline(LightProgram, 'fx.light'),
    render: pipeline(RenderProgram, 'fx.render'),
    pack: pipeline(PackProgram, 'fx.pack'),
    occupancy: pipeline(OccupancyProgram, 'fx.occupancy'),
    reduce: pipeline(ReduceProgram, 'fx.reduce'),
    detail: pipeline(DetailProgram, 'fx.detail'),
    detailPack: pipeline(DetailPackProgram, 'fx.detailPack'),
    shadow: pipeline(ShadowProgram, 'fx.shadow'),
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
      sources: group(pipes.sources, `fx.sources.${cur}`, [vel[cur], sca[cur], solid, burned]),
      curl: group(pipes.curl, `fx.curl.${cur}`, [vel[cur], curl]),
      confine: group(pipes.confine, `fx.confine.${cur}`, [curl, vel[cur]]),
      advect: group(pipes.advect, `fx.advect.${cur}`, [vel[cur], sca[cur], vel[nxt], sca[nxt], solid]),
      mcBack: group(pipes.mcBack, `fx.mcBack.${cur}`, [vel[cur], sca[nxt], back]),
      mcCorrect: group(pipes.mcCorrect, `fx.mcCorrect.${cur}`, [vel[cur], sca[cur], back, sca[nxt]]),
      divergence: group(pipes.divergence, `fx.div.${cur}`, [vel[nxt], divergence, pressure[0], solid, burned]),
      project: [0, 1].map(pp => group(pipes.project, `fx.project.${cur}.${pp}`, [pressure[pp], vel[nxt], sca[nxt], solid])),
      light: group(pipes.light, `fx.light.${cur}`, [sca[cur], light, solid, glow]),
    };
  });
  // The ground shadow's area (x0, z0, size in voxels, resolution), and its groups per target texture.
  const shadowArea = device.createBuffer({ label: 'fx.shadowArea', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
  owned.push(shadowArea);
  const shadowGroups = new Map<EngineTexture, BindGroup[]>();
  const reduceGroup = device.createBindGroup({
    label: 'fx.reduce', layout: pipes.reduce.bindGroupLayouts[0],
    entries: [{ binding: 0, buffer: uniforms }, { binding: 1, buffer: bricksum }, { binding: 2, storageTextureView: device.createWholeTextureView(fireTexture) }],
  });
  const detailGroups = [0, 1].map(c => group(pipes.detail, `fx.detail.${c}`, [vel[0], detailA[c], detailB[c], detailA[1 - c], detailB[1 - c]]));
  const detailGroupsVel1 = [0, 1].map(c => group(pipes.detail, `fx.detail.v1.${c}`, [vel[1], detailA[c], detailB[c], detailA[1 - c], detailB[1 - c]]));
  const jacobi = [0, 1].map(pp => group(pipes.jacobi, `fx.jacobi.${pp}`, [divergence, pressure[pp], pressure[1 - pp], solid]));
  // In place on pressure[0], which the warm start keeps from step to step.
  const jacobiRB = [0, 1].map(c => group(pipes.jacobiRB, `fx.jacobiRB.${c}`, [divergence, pressure[0], solid, colours[c]]));

  let tileTexture: Texture | null = null;
  let tileSize = 0;
  let renderGroups: BindGroup[] = [];
  let cur = 0;
  let time = 0;
  let steps = 0;
  let lutUploaded: Float32Array | null = null;
  const stage: StageState = { wind: null, solids: false };

  const wg = (n: number) => Math.ceil(n / 4);
  // The live preview's pack groups, per parity, for the one volume texture they were built against.
  // Keyed by texture: the node double-buffers its volume, so packs alternate between two targets.
  const packGroups = new Map<EngineTexture, BindGroup[]>();
  const occupancyGroups = new Map<EngineTexture, BindGroup[]>();

  /** Record the light pass for the current state into `encoder`. */
  const recordLight = (encoder: ReturnType<typeof device.createCommandEncoder>) => {
    const lightPass = encoder.beginComputePass('fx.light');
    lightPass.setPipeline(pipes.light);
    lightPass.setBindGroup(0, groups[cur].light);
    lightPass.dispatchWorkgroups(wg(Math.ceil(dims.nx / 2)), wg(Math.ceil(dims.ny / 2)), wg(Math.ceil(dims.nz / 2)));
    lightPass.end();
  };

  return {
    kind: 'gpu',
    dims,
    step(p, dt) {
      // A detail set goes back to the rest grid in the step its phase wraps (set B half a period later).
      const half = DETAIL_PERIOD / 2;
      const resets: [boolean, boolean] = [detailPhase(time + dt) < detailPhase(time), detailPhase(time + dt + half) < detailPhase(time + half)];
      device.writeBuffer(uniforms, 0, new Uint8Array(packUniforms(p, dims, dt, time, steps, tileSize, stage, resets)));
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
      if (p.advection === 'maccormack') {
        dispatch(pipes.mcBack, g.mcBack, 'fx.mcBack');
        dispatch(pipes.mcCorrect, g.mcCorrect, 'fx.mcCorrect');
      }
      dispatch(pipes.divergence, g.divergence, 'fx.divergence');
      let pp = 0;
      if (p.pressureSolver === 'sor') {
        for (let it = 0; it < p.pressureIterations; it++) {
          dispatch(pipes.jacobiRB, jacobiRB[0], 'fx.jacobiRB');
          dispatch(pipes.jacobiRB, jacobiRB[1], 'fx.jacobiRB');
        }
      } else {
        for (let it = 0; it < p.pressureIterations; it++) {
          dispatch(pipes.jacobi, jacobi[pp], 'fx.jacobi');
          pp = 1 - pp;
        }
      }
      dispatch(pipes.project, g.project[pp], 'fx.project');
      if ((p.detailStrength ?? 0) > 0) {
        // The coordinates ride the velocity just projected (now in vel[1 - cur]).
        const pass = encoder.beginComputePass('fx.detail');
        pass.setPipeline(pipes.detail);
        pass.setBindGroup(0, (cur === 0 ? detailGroupsVel1 : detailGroups)[detailCur]);
        pass.dispatchWorkgroups(wg(Math.ceil(dims.nx / 2)), wg(Math.ceil(dims.ny / 2)), wg(Math.ceil(dims.nz / 2)));
        pass.end();
        detailCur = 1 - detailCur;
      }
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
            { binding: 5, buffer: glow },
            { binding: 6, buffer: detailA[0] },
            { binding: 7, buffer: detailB[0] },
          ],
        }));
      }
      // The tile size and camera live in the uniform block too; rewrite it for this frame.
      device.writeBuffer(uniforms, 0, new Uint8Array(packUniforms(p, dims, 0, time, steps, tile, stage)));
      const encoder = device.createCommandEncoder('fx.render');
      recordLight(encoder);
      const pass = encoder.beginComputePass('fx.render');
      pass.setPipeline(pipes.render);
      // The render groups hold detail set 0 of each pair; rebuild them against the live parity's buffers.
      pass.setBindGroup(0, detailCur === 0 ? renderGroups[cur] : device.createBindGroup({
        label: `fx.render.${cur}.d1`, layout: pipes.render.bindGroupLayouts[0],
        entries: [
          { binding: 0, buffer: uniforms }, { binding: 1, buffer: sca[cur] }, { binding: 2, buffer: light },
          { binding: 3, buffer: lut }, { binding: 4, storageTextureView: device.createWholeTextureView(tileTexture!) },
          { binding: 5, buffer: glow }, { binding: 6, buffer: detailA[1] }, { binding: 7, buffer: detailB[1] },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(tile / 8), Math.ceil(tile / 8), 1);
      pass.end();
      encoder.finish();
      return device.readPixels(device.createTextureView(tileTexture), 0, 0, tile, tile);
    },
    packVolume(p, volume, occupancy, detail) {
      let groupsFor = packGroups.get(volume);
      if (!groupsFor) {
        if (packGroups.size >= 4) packGroups.clear();
        const view = device.createWholeTextureView(volume.rhiTexture);
        groupsFor = [0, 1].map(c => device.createBindGroup({
          label: `fx.pack.${c}`,
          layout: pipes.pack.bindGroupLayouts[0],
          entries: [
            { binding: 0, buffer: uniforms },
            { binding: 1, buffer: sca[c] },
            { binding: 2, buffer: light },
            { binding: 3, buffer: glow },
            { binding: 4, storageTextureView: view },
          ],
        }));
        packGroups.set(volume, groupsFor);
      }
      // The light direction and absorption live in the uniform block; rewrite it for this pack.
      device.writeBuffer(uniforms, 0, new Uint8Array(packUniforms(p, dims, 0, time, steps, tileSize, stage)));
      const encoder = device.createCommandEncoder('fx.pack');
      recordLight(encoder);
      const pass = encoder.beginComputePass('fx.pack');
      pass.setPipeline(pipes.pack);
      pass.setBindGroup(0, groupsFor[cur]);
      pass.dispatchWorkgroups(wg(dims.nx), wg(dims.ny), wg(dims.nz));
      pass.end();
      if (occupancy) {
        let occ = occupancyGroups.get(occupancy);
        if (!occ) {
          occupancyGroups.clear();
          const view = device.createWholeTextureView(occupancy.rhiTexture);
          occ = [0, 1].map(c => device.createBindGroup({
            label: `fx.occupancy.${c}`,
            layout: pipes.occupancy.bindGroupLayouts[0],
            entries: [{ binding: 0, buffer: uniforms }, { binding: 1, buffer: sca[c] }, { binding: 2, storageTextureView: view }, { binding: 3, buffer: bricksum }],
          }));
          occupancyGroups.set(occupancy, occ);
        }
        const bricks = [Math.ceil(dims.nx / 8), Math.ceil(dims.ny / 8), Math.ceil(dims.nz / 8)];
        const op = encoder.beginComputePass('fx.occupancy');
        op.setPipeline(pipes.occupancy);
        op.setBindGroup(0, occ[cur]);
        op.dispatchWorkgroups(wg(bricks[0]), wg(bricks[1]), wg(bricks[2]));
        op.end();
        const rp = encoder.beginComputePass('fx.reduce');
        rp.setPipeline(pipes.reduce);
        rp.setBindGroup(0, reduceGroup);
        rp.dispatchWorkgroups(1, 1, 1);
        rp.end();
      }
      if (detail && (p.detailStrength ?? 0) > 0) {
        const dp = encoder.beginComputePass('fx.detailPack');
        dp.setPipeline(pipes.detailPack);
        dp.setBindGroup(0, device.createBindGroup({
          label: 'fx.detailPack', layout: pipes.detailPack.bindGroupLayouts[0],
          entries: [
            { binding: 0, buffer: uniforms }, { binding: 1, buffer: detailA[detailCur] }, { binding: 2, buffer: detailB[detailCur] },
            { binding: 3, storageTextureView: device.createWholeTextureView(detail[0].rhiTexture) },
            { binding: 4, storageTextureView: device.createWholeTextureView(detail[1].rhiTexture) },
          ],
        }));
        dp.dispatchWorkgroups(wg(Math.ceil(dims.nx / 2)), wg(Math.ceil(dims.ny / 2)), wg(Math.ceil(dims.nz / 2)));
        dp.end();
      }
      encoder.finish();
    },
    groundShadow(_p, texture, area) {
      device.writeBuffer(shadowArea, 0, new Uint8Array(new Float32Array([area.x0, area.z0, area.size, area.res]).buffer));
      let groupFor = shadowGroups.get(texture);
      if (!groupFor) {
        shadowGroups.clear();
        groupFor = [0, 1].map(c => device.createBindGroup({
          label: `fx.shadow.${c}`, layout: pipes.shadow.bindGroupLayouts[0],
          entries: [
            { binding: 0, buffer: uniforms }, { binding: 1, buffer: sca[c] }, { binding: 2, buffer: shadowArea },
            { binding: 3, storageTextureView: device.createWholeTextureView(texture.rhiTexture) },
          ],
        }));
        shadowGroups.set(texture, groupFor);
      }
      const encoder = device.createCommandEncoder('fx.shadow');
      const pass = encoder.beginComputePass('fx.shadow');
      pass.setPipeline(pipes.shadow);
      pass.setBindGroup(0, groupFor[cur]);
      pass.dispatchWorkgroups(Math.ceil(area.res / 8), Math.ceil(area.res / 8), 1);
      pass.end();
      encoder.finish();
    },
    async fireLight() {
      const px = await device.readPixels(device.createTextureView(fireTexture), 0, 0, 1, 1);
      return [px[0] / 255, px[1] / 255, px[2] / 255, px[3] / 255] as [number, number, number, number];
    },
    setSolid(mask) {
      // u32 per voxel: WGSL storage has no bytes. Zeros when cleared, so a stale mask never lingers.
      const words = new Uint32Array(cells);
      if (mask) for (let i = 0; i < cells; i++) words[i] = mask[i];
      device.writeBuffer(solid, 0, new Uint8Array(words.buffer));
      stage.solids = !!mask;
    },
    setSceneWind(wind) {
      stage.wind = wind;
    },
    dispose() {
      tileTexture?.destroy();
      for (const r of owned) r.destroy();
    },
  };
}
