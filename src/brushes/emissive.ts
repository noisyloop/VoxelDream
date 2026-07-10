// The emissive brush — the first brush anyone earns (lesson: 01-light).
//
// Algorithm: trivially, one voxel. Place stamps an emissive material into
// the empty cell adjacent to the face you clicked (the same rule every
// voxel editor uses: build *on* surfaces); erase removes the voxel you
// clicked. What the brush teaches isn't the stamp — it's what the renderer
// does with an emissive material afterwards: the voxel becomes a light
// source that every other surface starts answering to.

import type { History } from "../core/history";
import type { RayHit } from "../core/raycast";
import type { World } from "../core/world";
import { WORLD_SIZE } from "../render/dreaming/renderer";

export const LESSON_ID = "01-light";

export interface BrushResult {
  x: number;
  y: number;
  z: number;
  mat: number;
}

/** Stamp one emissive voxel on the face the ray hit. Null if out of bounds/occupied. */
export function place(world: World, history: History, hit: RayHit, mat: number): BrushResult | null {
  const x = hit.x + hit.nx;
  const y = hit.y + hit.ny;
  const z = hit.z + hit.nz;
  if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE || z >= WORLD_SIZE) return null;
  if (world.get(x, y, z) !== 0) return null;
  history.apply(world, [{ x, y, z, mat }]);
  return { x, y, z, mat };
}

/** Erase the voxel the ray hit. */
export function erase(world: World, history: History, hit: RayHit): BrushResult {
  history.apply(world, [{ x: hit.x, y: hit.y, z: hit.z, mat: 0 }]);
  return { x: hit.x, y: hit.y, z: hit.z, mat: 0 };
}
