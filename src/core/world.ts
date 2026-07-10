// Chunked sparse voxel storage: 32³ chunks, each holding 4³ bricks of 8³.
//
// Chunks and bricks are allocated lazily on first write and dropped when
// they empty out, so an infinite world costs only what's actually filled.
// The renderer doesn't read this structure directly — it uploads a dense
// region snapshot (see render/dreaming) — but the brick granularity here is
// what makes partial GPU updates and dirty-tracking cheap.

import { Brick, BRICK_SIZE } from "./brick";

export const CHUNK_SIZE = 32;
const BRICKS_PER_AXIS = CHUNK_SIZE / BRICK_SIZE; // 4

class Chunk {
  readonly bricks: (Brick | null)[] = new Array(BRICKS_PER_AXIS ** 3).fill(null);
  nonEmptyBricks = 0;
}

function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

export class World {
  private chunks = new Map<string, Chunk>();
  /** Brick-granular dirty set ("bx,by,bz" in brick coords) since last clearDirty. */
  readonly dirtyBricks = new Set<string>();

  get(x: number, y: number, z: number): number {
    const chunk = this.chunks.get(chunkKey(x >> 5, y >> 5, z >> 5));
    if (!chunk) return 0;
    const brick = chunk.bricks[brickIndexInChunk(x, y, z)];
    if (!brick) return 0;
    return brick.get(Brick.index(x & 7, y & 7, z & 7));
  }

  /** Set a voxel; returns the previous material index. */
  set(x: number, y: number, z: number, mat: number): number {
    const key = chunkKey(x >> 5, y >> 5, z >> 5);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      if (mat === 0) return 0;
      chunk = new Chunk();
      this.chunks.set(key, chunk);
    }
    const bi = brickIndexInChunk(x, y, z);
    let brick = chunk.bricks[bi];
    if (!brick) {
      if (mat === 0) return 0;
      brick = new Brick();
      chunk.bricks[bi] = brick;
      chunk.nonEmptyBricks++;
    }
    const prev = brick.set(Brick.index(x & 7, y & 7, z & 7), mat);
    if (prev !== mat) {
      this.dirtyBricks.add(`${x >> 3},${y >> 3},${z >> 3}`);
      if (brick.count === 0) {
        chunk.bricks[bi] = null;
        chunk.nonEmptyBricks--;
        if (chunk.nonEmptyBricks === 0) this.chunks.delete(key);
      }
    }
    return prev;
  }

  clearDirty(): void {
    this.dirtyBricks.clear();
  }

  /** Visit every non-empty voxel. Order: chunks unordered, voxels x-fastest within bricks. */
  forEach(fn: (x: number, y: number, z: number, mat: number) => void): void {
    for (const [key, chunk] of this.chunks) {
      const parts = key.split(",");
      const cx = Number(parts[0]) * CHUNK_SIZE;
      const cy = Number(parts[1]) * CHUNK_SIZE;
      const cz = Number(parts[2]) * CHUNK_SIZE;
      for (let bi = 0; bi < chunk.bricks.length; bi++) {
        const brick = chunk.bricks[bi];
        if (!brick) continue;
        const bx = cx + (bi % BRICKS_PER_AXIS) * BRICK_SIZE;
        const by = cy + (Math.floor(bi / BRICKS_PER_AXIS) % BRICKS_PER_AXIS) * BRICK_SIZE;
        const bz = cz + Math.floor(bi / (BRICKS_PER_AXIS * BRICKS_PER_AXIS)) * BRICK_SIZE;
        for (let i = 0; i < 512; i++) {
          const mat = brick.materials[i]!;
          if (mat !== 0) {
            fn(bx + (i & 7), by + ((i >> 3) & 7), bz + (i >> 6), mat);
          }
        }
      }
    }
  }

  /** Total non-empty voxel count (walks bricks; used by tests and HUD). */
  countVoxels(): number {
    let n = 0;
    for (const chunk of this.chunks.values()) {
      for (const brick of chunk.bricks) if (brick) n += brick.count;
    }
    return n;
  }
}

function brickIndexInChunk(x: number, y: number, z: number): number {
  const bx = (x >> 3) & 3;
  const by = (y >> 3) & 3;
  const bz = (z >> 3) & 3;
  return bx + by * BRICKS_PER_AXIS + bz * BRICKS_PER_AXIS * BRICKS_PER_AXIS;
}
