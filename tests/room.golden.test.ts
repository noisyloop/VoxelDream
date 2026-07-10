// Golden-hash tests for deterministic procedural generators.
//
// We pin a hash of the generated output, never the output itself (SPEC:
// store the hash, not the image). If one of these fails you either changed
// a generator deliberately — update the hash in the same commit and say so —
// or you broke determinism, which is a bug.

import { describe, expect, it } from "vitest";
import { fnv1a } from "./golden";
import { generateRoom, roomVoxel, ROOM_SEED, ROOM_SIZE } from "../src/dreams/room";
import { World } from "../src/core/world";
import { generateDefaultPalette, paletteToFloat32Array } from "../src/core/palette";

function bakeRoomGrid(): Uint8Array {
  const grid = new Uint8Array(ROOM_SIZE ** 3);
  let i = 0;
  for (let z = 0; z < ROOM_SIZE; z++) {
    for (let y = 0; y < ROOM_SIZE; y++) {
      for (let x = 0; x < ROOM_SIZE; x++) {
        grid[i++] = roomVoxel(x, y, z, ROOM_SEED);
      }
    }
  }
  return grid;
}

describe("dream 01 room generator", () => {
  it("is deterministic (golden hash)", () => {
    expect(fnv1a(bakeRoomGrid())).toBe("ee0aba99");
  });

  it("generateRoom(world) matches roomVoxel exactly", () => {
    const w = new World();
    const placed = generateRoom(w);
    const grid = bakeRoomGrid();
    let solid = 0;
    let mismatches = 0;
    let i = 0;
    for (let z = 0; z < ROOM_SIZE; z++) {
      for (let y = 0; y < ROOM_SIZE; y++) {
        for (let x = 0; x < ROOM_SIZE; x++) {
          const expected = grid[i++]!;
          if (expected !== 0) solid++;
          if (w.get(x, y, z) !== expected) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(placed).toBe(solid);
    expect(w.countVoxels()).toBe(solid);
  });

  it("the ceiling crack is open (the room must leak a little sky)", () => {
    let open = 0;
    for (let x = 11; x < 54; x++) {
      if (roomVoxel(x, ROOM_SIZE - 1, 31, ROOM_SEED) === 0) open++;
    }
    expect(open).toBeGreaterThan(10);
  });

  it("the room is sealed apart from the crack (floor and walls solid)", () => {
    for (let x = 0; x < ROOM_SIZE; x++) {
      for (let z = 0; z < ROOM_SIZE; z++) {
        expect(roomVoxel(x, 0, z, ROOM_SEED)).not.toBe(0);
        expect(roomVoxel(x, 5, 0, ROOM_SEED)).not.toBe(0);
      }
    }
  });
});

describe("default palette", () => {
  it("is deterministic (golden hash)", () => {
    expect(fnv1a(new Uint8Array(paletteToFloat32Array(generateDefaultPalette()).buffer))).toBe(
      "aeae48ad"
    );
  });
});
