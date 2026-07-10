// Deterministic integer hashing, shared by everything procedural.
//
// This is the PCG output function from Jarzynski & Olano, "Hash Functions for
// GPU Rendering" (JCGT 2020) — their survey's recommended single-word hash.
// It is written here in GLSL-translatable style on purpose: the Shadertoy
// exporter (src/export/shader.ts) emits a byte-identical GLSL twin, and the
// room generator relies on both producing the same bits for the same input.
// All arithmetic is explicit u32 (Math.imul + >>>0); do not "simplify" it.

export function pcg(v: number): number {
  const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Hash three coordinates and a seed into one u32. Nested PCG, order matters. */
export function hash3(x: number, y: number, z: number, seed: number): number {
  return pcg((x >>> 0) + pcg((y >>> 0) + pcg(((z >>> 0) ^ (seed >>> 0)) >>> 0)));
}

/** Uniform float in [0, 1) from a u32 hash. */
export function hashToFloat(h: number): number {
  return (h >>> 0) / 4294967296;
}
