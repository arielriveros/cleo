// Placed bodies as the solver sees them: a solid mask, one byte per voxel (1 = solid). Voxelised
// analytically from each body's signed distance, so a body is exactly as big in the gas as it is drawn.
//
// The grid matches the live preview's FluidVolumeNode: voxel (x, y, z) has its centre at world
// origin + (x + 0.5, y + 0.5, z + 0.5) * voxelSize, where `origin` is the region's low corner -- by default
// (-nx/2, 0, -nz/2) * voxelSize, a box standing centred on the world origin.

import type { FluidDims } from './fluidCpu';
import type { FxBody } from './fxScene';

type V3 = [number, number, number];

/** Body-local point: undo the yaw (around Y), then the pitch (around the body's X). */
function toLocal(b: FxBody, w: V3): V3 {
  const dx = w[0] - b.position[0], dy = w[1] - b.position[1], dz = w[2] - b.position[2];
  const yaw = (b.yaw * Math.PI) / 180, pitch = (b.pitch * Math.PI) / 180;
  // Ry(-yaw): engine Ry(a) maps x' = x cos a + z sin a, z' = -x sin a + z cos a.
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = dx * cy - dz * sy, z1 = dx * sy + dz * cy;
  // Rx(-pitch): engine Rx(a) maps y' = y cos a - z sin a, z' = y sin a + z cos a.
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [x1, dy * cp + z1 * sp, -dy * sp + z1 * cp];
}

/** Signed distance from a body's surface, metres: negative inside. */
export function bodyDistance(b: FxBody, w: V3): number {
  const p = toLocal(b, w);
  switch (b.kind) {
    case 'sphere': return Math.hypot(p[0], p[1], p[2]) - b.size[0] / 2;
    case 'capsule': {
      const r = b.size[0] / 2;
      const half = Math.max(0, b.size[1] / 2 - r);
      const y = Math.min(half, Math.max(-half, p[1]));
      return Math.hypot(p[0], p[1] - y, p[2]) - r;
    }
    default: {
      const qx = Math.abs(p[0]) - b.size[0] / 2, qy = Math.abs(p[1]) - b.size[1] / 2, qz = Math.abs(p[2]) - b.size[2] / 2;
      const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
      return out + Math.min(Math.max(qx, qy, qz), 0);
    }
  }
}

/** World AABB of a body, for skipping voxels it cannot touch. */
function bodyBounds(b: FxBody): { min: V3; max: V3 } {
  const r = b.kind === 'sphere' ? b.size[0] / 2 : 0.5 * Math.hypot(b.size[0], b.size[1], b.size[2]);
  return { min: [b.position[0] - r, b.position[1] - r, b.position[2] - r], max: [b.position[0] + r, b.position[1] + r, b.position[2] + r] };
}

/**
 * The solid mask for `bodies` on a grid of `dims` voxels of `voxelSize` metres, or null when no visible
 * body reaches the grid (the solver then runs its plain, mask-free path).
 */
export function voxelizeBodies(bodies: readonly FxBody[], dims: FluidDims, voxelSize: number,
                               origin: readonly [number, number, number] = [-dims.nx * voxelSize / 2, 0, -dims.nz * voxelSize / 2]): Uint8Array | null {
  const { nx, ny, nz } = dims;
  const live = bodies.filter(b => b.visible);
  if (live.length === 0) return null;
  const mask = new Uint8Array(nx * ny * nz);
  // The low corner in voxel units, so a world coordinate w sits at voxel w / voxelSize - o - 0.5.
  const ox = origin[0] / voxelSize, oy = origin[1] / voxelSize, oz = origin[2] / voxelSize;
  let solid = 0;
  for (const b of live) {
    const bb = bodyBounds(b);
    const lo = (v: number, o: number) => Math.max(0, Math.floor(v / voxelSize - o - 0.5));
    const hi = (v: number, o: number, n: number) => Math.min(n - 1, Math.ceil(v / voxelSize - o - 0.5));
    const x0 = lo(bb.min[0], ox), x1 = hi(bb.max[0], ox, nx);
    const y0 = lo(bb.min[1], oy), y1 = hi(bb.max[1], oy, ny);
    const z0 = lo(bb.min[2], oz), z1 = hi(bb.max[2], oz, nz);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = x + nx * (y + ny * z);
      if (mask[i]) continue;
      const w: V3 = [(ox + x + 0.5) * voxelSize, (oy + y + 0.5) * voxelSize, (oz + z + 0.5) * voxelSize];
      if (bodyDistance(b, w) <= 0) { mask[i] = 1; solid++; }
    }
  }
  return solid > 0 ? mask : null;
}
