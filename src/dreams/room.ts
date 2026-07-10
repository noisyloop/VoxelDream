// The Dream 01 room: a dark 64³ chamber, generated at load.
//
// `roomVoxel` is a pure function (x, y, z, seed) → material index, written
// in integer-only, branch-simple style ON PURPOSE: the Shadertoy exporter
// (src/export/shader.ts) emits a line-for-line GLSL translation of it, so a
// baked export reproduces the room without embedding 64³ of data. If you
// change this function, change the GLSL twin in the same commit — the golden
// tests pin both.
//
// Layout: double-thick floor/ceiling/walls, a jagged crack down the middle
// of the ceiling that leaks a whisper of night sky (so the unlit room is
// barely readable), four 3×3 pillars, wall trim bands, and hash-scattered
// rubble on the floor.

import { hash3 } from "../core/hash";
import { MAT } from "../core/palette";
import type { World } from "../core/world";

export const ROOM_SIZE = 64;
export const ROOM_SEED = 1337;

export function roomVoxel(x: number, y: number, z: number, seed: number): number {
  const S = ROOM_SIZE;
  if (x < 0 || y < 0 || z < 0 || x >= S || y >= S || z >= S) return MAT.EMPTY;

  // Ceiling, with the crack. The crack runs along x at z = 31..32, jagged
  // edges and occasional blockages decided by hash.
  if (y >= S - 2) {
    const jag = hash3(x, 0, 0, seed) & 3; // 0..3
    const halfWidth = jag === 0 ? 0 : 1; // pinches shut where jag == 0
    const inCrack = x > 10 && x < 54 && z >= 31 - halfWidth && z <= 32 + halfWidth;
    return inCrack ? MAT.EMPTY : MAT.CEILING;
  }

  // Floor: two courses, 8×8 checkerboard of two stones.
  if (y <= 1) {
    return (((x >> 3) + (z >> 3)) & 1) === 0 ? MAT.FLOOR_A : MAT.FLOOR_B;
  }

  // Walls: two voxels thick, with a trim band every 14 courses.
  const wallDist = Math.min(x, z, S - 1 - x, S - 1 - z);
  if (wallDist <= 1) {
    return y % 14 === 7 ? MAT.TRIM : MAT.WALL;
  }

  // Four 3×3 pillars, floor to ceiling, centered at 16/47 on each axis.
  const px = Math.abs(x - 16) <= 1 || Math.abs(x - 47) <= 1 ? 1 : 0;
  const pz = Math.abs(z - 16) <= 1 || Math.abs(z - 47) <= 1 ? 1 : 0;
  if (px === 1 && pz === 1) {
    return MAT.PILLAR;
  }

  // Rubble: sparse single voxels resting on the floor.
  if (y === 2 && hash3(x, y, z, seed) % 89 < 2) {
    return MAT.RUBBLE;
  }

  return MAT.EMPTY;
}

/** Fill a world with the room. Returns the number of solid voxels placed. */
export function generateRoom(world: World, seed = ROOM_SEED): number {
  let placed = 0;
  for (let z = 0; z < ROOM_SIZE; z++) {
    for (let y = 0; y < ROOM_SIZE; y++) {
      for (let x = 0; x < ROOM_SIZE; x++) {
        const mat = roomVoxel(x, y, z, seed);
        if (mat !== 0) {
          world.set(x, y, z, mat);
          placed++;
        }
      }
    }
  }
  return placed;
}
