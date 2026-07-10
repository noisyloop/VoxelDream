import { describe, expect, it } from "vitest";
import { Brick } from "../src/core/brick";
import { World } from "../src/core/world";
import { History } from "../src/core/history";
import { raycast } from "../src/core/raycast";
import { pcg, hash3 } from "../src/core/hash";
import { generateDefaultPalette, MAT } from "../src/core/palette";

describe("brick", () => {
  it("keeps materials and occupancy bitmask in sync", () => {
    const b = new Brick();
    const i = Brick.index(3, 5, 7);
    expect(b.occupied(i)).toBe(false);
    b.set(i, 42);
    expect(b.get(i)).toBe(42);
    expect(b.occupied(i)).toBe(true);
    expect(b.count).toBe(1);
    b.set(i, 0);
    expect(b.occupied(i)).toBe(false);
    expect(b.count).toBe(0);
  });
});

describe("world", () => {
  it("stores and retrieves voxels across chunk boundaries", () => {
    const w = new World();
    const coords: [number, number, number][] = [
      [0, 0, 0],
      [31, 31, 31],
      [32, 0, 0],
      [63, 63, 63],
      [7, 8, 9],
    ];
    coords.forEach(([x, y, z], i) => w.set(x, y, z, i + 1));
    coords.forEach(([x, y, z], i) => expect(w.get(x, y, z)).toBe(i + 1));
    expect(w.get(1, 2, 3)).toBe(0);
    expect(w.countVoxels()).toBe(coords.length);
  });

  it("tracks dirty bricks and frees emptied bricks", () => {
    const w = new World();
    w.set(10, 10, 10, 5);
    expect(w.dirtyBricks.has("1,1,1")).toBe(true);
    w.clearDirty();
    w.set(10, 10, 10, 5); // no-op, same material
    expect(w.dirtyBricks.size).toBe(0);
    w.set(10, 10, 10, 0);
    expect(w.dirtyBricks.size).toBe(1);
    expect(w.countVoxels()).toBe(0);
  });

  it("forEach visits exactly the non-empty voxels", () => {
    const w = new World();
    w.set(1, 2, 3, 7);
    w.set(40, 2, 3, 9);
    const seen: string[] = [];
    w.forEach((x, y, z, m) => seen.push(`${x},${y},${z}:${m}`));
    expect(seen.sort()).toEqual(["1,2,3:7", "40,2,3:9"]);
  });
});

describe("history", () => {
  it("undoes and redoes a batch as one command", () => {
    const w = new World();
    const h = new History();
    h.apply(w, [
      { x: 0, y: 0, z: 0, mat: 1 },
      { x: 1, y: 0, z: 0, mat: 2 },
    ]);
    expect(w.get(1, 0, 0)).toBe(2);
    expect(h.undo(w)).toBe(true);
    expect(w.get(0, 0, 0)).toBe(0);
    expect(w.get(1, 0, 0)).toBe(0);
    expect(h.redo(w)).toBe(true);
    expect(w.get(1, 0, 0)).toBe(2);
  });

  it("round-trips through JSON", () => {
    const w = new World();
    const h = new History();
    h.apply(w, [{ x: 5, y: 5, z: 5, mat: 3 }]);
    const h2 = History.deserialize(h.serialize());
    expect(h2.undo(w)).toBe(true);
    expect(w.get(5, 5, 5)).toBe(0);
  });
});

describe("raycast (Amanatides–Woo)", () => {
  it("hits the expected voxel and face", () => {
    const w = new World();
    w.set(10, 5, 5, 3);
    const hit = raycast(w, 0.5, 5.5, 5.5, 1, 0, 0);
    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z]).toEqual([10, 5, 5]);
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([-1, 0, 0]); // hit the -x face
    expect(hit!.t).toBeCloseTo(9.5);
  });

  it("misses when nothing is along the ray", () => {
    const w = new World();
    w.set(10, 5, 5, 3);
    expect(raycast(w, 0.5, 20.5, 5.5, 1, 0, 0, 64)).toBeNull();
  });

  it("traverses diagonals without skipping voxels", () => {
    const w = new World();
    w.set(7, 7, 7, 1);
    const hit = raycast(w, 0.5, 0.5, 0.5, 1, 1, 1);
    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z]).toEqual([7, 7, 7]);
  });
});

describe("hash", () => {
  it("pcg matches known u32 behavior and is deterministic", () => {
    expect(pcg(0)).toBe(pcg(0));
    expect(pcg(1)).not.toBe(pcg(2));
    // Stays in u32 range.
    for (const v of [0, 1, 12345, 0xffffffff]) {
      const h = pcg(v);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it("hash3 differs across axes (no symmetry)", () => {
    expect(hash3(1, 2, 3, 0)).not.toBe(hash3(3, 2, 1, 0));
    expect(hash3(1, 2, 3, 0)).not.toBe(hash3(1, 2, 3, 1));
  });
});

describe("palette", () => {
  it("entry 0 is empty and lights are emissive", () => {
    const p = generateDefaultPalette();
    expect(p[MAT.EMPTY]).toEqual({ r: 0, g: 0, b: 0, emissive: 0 });
    expect(p[MAT.LIGHT_WARM]!.emissive).toBeGreaterThan(0);
    expect(p[MAT.WALL]!.emissive).toBe(0);
    expect(p).toHaveLength(256);
  });
});
