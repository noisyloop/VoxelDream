// Tests for the Shadertoy exporter.
//
// We can't compile GLSL inside vitest, but we can prove the *data* is
// lossless: parse the packed EDITS uints back out of the emitted source,
// replay the same "generator + diff" lookup the shader performs, and
// compare every voxel of the 64³ world. The GLSL-twin-of-roomVoxel side is
// pinned by the golden hash (and validated for real in a browser — see
// tests/browser/, and the manual Shadertoy acceptance check in SPEC.md).

import { beforeAll, describe, expect, it } from "vitest";
import { exportShader, MAX_EXPORT_LIGHTS } from "../src/export/shader";
import { World } from "../src/core/world";
import { generateRoom, roomVoxel, ROOM_SEED, ROOM_SIZE } from "../src/dreams/room";
import { generateDefaultPalette, MAT } from "../src/core/palette";
import { fnv1aString } from "./golden";

const palette = generateDefaultPalette();

function buildScenario(): World {
  const world = new World();
  generateRoom(world);
  // The canonical Dream 01 outcome: one warm light placed mid-air…
  world.set(30, 10, 30, MAT.LIGHT_WARM);
  // …plus a sandbox edit of each kind: another hue, and an erased wall voxel.
  world.set(20, 30, 40, MAT.LIGHT_WARM + 3);
  world.set(1, 10, 10, 0);
  return world;
}

describe("shader export (Shadertoy target)", () => {
  let glsl: string;
  let world: World;

  beforeAll(() => {
    world = buildScenario();
    const result = exportShader(world, palette);
    glsl = result.glsl;
    expect(result.warnings).toEqual([]);
    expect(result.editCount).toBe(3);
    expect(result.lightCount).toBe(2);
  });

  it("declares nothing Shadertoy injects", () => {
    expect(glsl).not.toContain("#version");
    expect(glsl).not.toMatch(/^\s*uniform\s/m);
    expect(glsl).not.toMatch(/void\s+main\s*\(\s*\)/);
    expect(glsl).toContain("void mainImage(out vec4 fragColor, in vec2 fragCoord)");
  });

  it("embeds the edit diff sorted for binary search", () => {
    const m = glsl.match(/const uint EDITS\[3\] = uint\[3\]\(\s*([^)]+)\)/);
    expect(m).not.toBeNull();
    const edits = m![1]!.split(",").map((s) => Number(s.trim().replace(/u$/, "")));
    const keys = edits.map((e) => e & 0x3ffff);
    expect([...keys].sort((a, b) => a - b)).toEqual(keys);
  });

  it("round-trips every voxel through generator + diff", () => {
    const m = glsl.match(/const uint EDITS\[\d+\] = uint\[\d+\]\(\s*([^)]+)\)/);
    const edits = new Map(
      m![1]!
        .split(",")
        .map((s) => Number(s.trim().replace(/u$/, "")))
        .map((e) => [e & 0x3ffff, (e >>> 18) & 0xff])
    );
    let mismatches = 0;
    for (let z = 0; z < ROOM_SIZE; z++) {
      for (let y = 0; y < ROOM_SIZE; y++) {
        for (let x = 0; x < ROOM_SIZE; x++) {
          const key = x | (y << 6) | (z << 12);
          const decoded = edits.has(key) ? edits.get(key)! : roomVoxel(x, y, z, ROOM_SEED);
          if (decoded !== world.get(x, y, z)) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
  });

  it("lists both lights with their materials", () => {
    expect(glsl).toContain("#define LIGHT_COUNT 2");
    expect(glsl).toContain(`vec4(30.5, 10.5, 30.5, ${MAT.LIGHT_WARM}.0)`);
    expect(glsl).toContain(`vec4(20.5, 30.5, 40.5, ${MAT.LIGHT_WARM + 3}.0)`);
  });

  it("is deterministic (golden hash of the emitted source)", () => {
    expect(fnv1aString(glsl)).toBe("4216fe9c");
  });

  it("handles the pristine room (zero edits, zero lights)", () => {
    const w = new World();
    generateRoom(w);
    const result = exportShader(w, palette);
    expect(result.editCount).toBe(0);
    expect(result.lightCount).toBe(0);
    expect(result.glsl).toContain("#define EDIT_COUNT 0");
    expect(result.glsl).not.toContain("const uint EDITS");
    expect(result.glsl).not.toContain("const vec4 LIGHTS");
  });

  it("warns when lights exceed the shadow budget", () => {
    const w = new World();
    generateRoom(w);
    for (let i = 0; i < MAX_EXPORT_LIGHTS + 4; i++) {
      w.set(10 + i, 20, 30, MAT.LIGHT_WARM);
    }
    const result = exportShader(w, palette);
    expect(result.warnings.some((s) => s.includes("cast shadows"))).toBe(true);
    expect(result.glsl).toContain(`#define LIGHT_COUNT ${MAX_EXPORT_LIGHTS}`);
  });
});
