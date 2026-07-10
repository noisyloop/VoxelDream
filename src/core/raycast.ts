// CPU voxel ray traversal — Amanatides & Woo, "A Fast Voxel Traversal
// Algorithm for Ray Tracing" (Eurographics 1987).
//
// This is the reference implementation of the same DDA the GPU runs in
// trace.wgsl: step one voxel at a time along the ray, always crossing the
// nearest axis boundary next. The CPU copy exists for picking (click →
// voxel under cursor) and as ground truth for tests.

/** Anything voxel-shaped: the World, or a dense snapshot of it. */
export interface VoxelSource {
  get(x: number, y: number, z: number): number;
}

export interface RayHit {
  /** The solid voxel that was hit. */
  x: number;
  y: number;
  z: number;
  mat: number;
  /** Face normal of the hit (unit axis, e.g. [0,1,0] = hit the top face). */
  nx: number;
  ny: number;
  nz: number;
  /** Ray parameter at the hit. */
  t: number;
}

export function raycast(
  world: VoxelSource,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT = 1024
): RayHit | null {
  // Current voxel.
  let vx = Math.floor(ox);
  let vy = Math.floor(oy);
  let vz = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  // t advance per one-voxel move along each axis, and t of first boundary.
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);
  let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? vx + 1 - ox : ox - vx) * tDeltaX) / 1;
  let tMaxY = dy === 0 ? Infinity : ((dy > 0 ? vy + 1 - oy : oy - vy) * tDeltaY) / 1;
  let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? vz + 1 - oz : oz - vz) * tDeltaZ) / 1;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  for (let i = 0; i < 4096; i++) {
    const mat = world.get(vx, vy, vz);
    if (mat !== 0 && t > 0) {
      return { x: vx, y: vy, z: vz, mat, nx, ny, nz, t };
    }
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      vx += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY <= tMaxZ) {
      vy += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      vz += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
    if (t > maxT) break;
  }
  return null;
}
