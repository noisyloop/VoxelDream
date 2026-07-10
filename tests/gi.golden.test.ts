// Golden-image tests for the GI integrator, via the CPU reference renderer
// (src/render/reference.ts — the same algorithm as trace.wgsl, on the same
// PCG sequences). Per SPEC we pin a hash of a deterministic render, never
// an image file.
//
// Note on determinism: this relies on V8's Math.* (fdlibm) being stable,
// which holds across platforms for a given V8 line. If a Node upgrade ever
// flips these hashes with no code change, re-pin them and say so in the
// commit — the *physical* assertions below are the real safety net.

import { describe, expect, it } from "vitest";
import { renderReference, tonemap } from "../src/render/reference";
import { World } from "../src/core/world";
import { generateRoom } from "../src/dreams/room";
import { generateDefaultPalette, MAT } from "../src/core/palette";
import { fnv1a } from "./golden";

const palette = generateDefaultPalette();

const CAMERA = { yaw: 0.8, pitch: 0.5, distance: 19, target: [32, 18, 32] as [number, number, number], fov: (55 * Math.PI) / 180 };
const SIZE = { width: 96, height: 54 };

function litWorld(): World {
  const world = new World();
  generateRoom(world);
  world.set(30, 10, 30, MAT.LIGHT_WARM); // the Dream 01 moment
  return world;
}

function meanLuminance(hdr: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < hdr.length; i += 3) {
    sum += hdr[i]! * 0.2126 + hdr[i + 1]! * 0.7152 + hdr[i + 2]! * 0.0722;
  }
  return sum / (hdr.length / 3);
}

describe("GI integrator (CPU reference of trace.wgsl)", () => {
  const world = litWorld();
  const on = renderReference(world, palette, { ...SIZE, spp: 24, giEnabled: true, camera: CAMERA });
  const off = renderReference(world, palette, { ...SIZE, spp: 24, giEnabled: false, camera: CAMERA });

  it("bounced light adds real energy — GI is not a point light with falloff", () => {
    const ratio = meanLuminance(on) / meanLuminance(off);
    expect(ratio).toBeGreaterThan(1.25);
  });

  it("GI brightens the regions direct light barely reaches", () => {
    // Take the darkest tenth of the direct-only image (the shadowed and
    // far corners); with GI on, that same set of pixels must gain at
    // least 2x luminance. This is exactly what "not a point light with
    // falloff" means: energy arriving where no straight line from the
    // light can.
    const pairs: [number, number][] = [];
    for (let i = 0; i < on.length; i += 3) {
      const lOff = off[i]! * 0.2126 + off[i + 1]! * 0.7152 + off[i + 2]! * 0.0722;
      const lOn = on[i]! * 0.2126 + on[i + 1]! * 0.7152 + on[i + 2]! * 0.0722;
      pairs.push([lOff, lOn]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const decile = pairs.slice(0, Math.floor(pairs.length / 10));
    const meanOff = decile.reduce((s, p) => s + p[0], 0) / decile.length;
    const meanOn = decile.reduce((s, p) => s + p[1], 0) / decile.length;
    expect(meanOn / Math.max(meanOff, 1e-6)).toBeGreaterThan(2);
  });

  it("an unlit room is nearly black either way", () => {
    const dark = new World();
    generateRoom(dark);
    const img = renderReference(dark, palette, { ...SIZE, spp: 8, giEnabled: true, camera: CAMERA });
    expect(meanLuminance(img)).toBeLessThan(0.02);
  });

  it("is deterministic (golden hashes of both renders)", () => {
    expect(fnv1a(new Uint8Array(tonemap(on)))).toBe("9049aa80");
    expect(fnv1a(new Uint8Array(tonemap(off)))).toBe("9ff2d091");
  });
});
