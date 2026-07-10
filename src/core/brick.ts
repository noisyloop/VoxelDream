// A brick: 8³ voxels, the unit of GPU traversal and of dirty-tracking.
//
// Two parallel representations, kept in sync by `set`:
//  - `materials`: one palette index per voxel (u8, 512 bytes)
//  - `occupancy`: one bit per voxel (16 × u32) — this is what the DDA in
//    trace.wgsl actually reads to skip empty space; materials are only
//    fetched on a confirmed hit.
// Voxel order is x + y*8 + z*64 (x fastest), matching the WGSL indexing.

export const BRICK_SIZE = 8;
export const VOXELS_PER_BRICK = BRICK_SIZE * BRICK_SIZE * BRICK_SIZE; // 512
export const OCCUPANCY_WORDS = VOXELS_PER_BRICK / 32; // 16

export class Brick {
  readonly materials = new Uint8Array(VOXELS_PER_BRICK);
  readonly occupancy = new Uint32Array(OCCUPANCY_WORDS);
  /** Number of non-empty voxels; 0 means the brick can be dropped. */
  count = 0;

  static index(x: number, y: number, z: number): number {
    return x + y * BRICK_SIZE + z * BRICK_SIZE * BRICK_SIZE;
  }

  get(i: number): number {
    return this.materials[i] ?? 0;
  }

  /** Returns the previous material at `i`. */
  set(i: number, mat: number): number {
    const prev = this.materials[i] ?? 0;
    if (prev === mat) return prev;
    this.materials[i] = mat;
    const word = i >> 5;
    const bit = 1 << (i & 31);
    if (mat === 0) {
      this.occupancy[word]! &= ~bit;
      this.count--;
    } else if (prev === 0) {
      this.occupancy[word]! |= bit;
      this.count++;
    }
    return prev;
  }

  occupied(i: number): boolean {
    return ((this.occupancy[i >> 5]! >>> (i & 31)) & 1) === 1;
  }
}
