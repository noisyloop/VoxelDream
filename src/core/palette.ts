// The 256-entry material palette. Generated, never loaded (SPEC constraint 1).
//
// Entry 0 is always "empty". Entries carry linear-space RGB plus an emissive
// intensity: 0 means a diffuse surface, >0 means the voxel radiates
// `rgb * emissive` — the renderer treats emissive voxels as the scene's only
// real light sources, which is the entire premise of Dream 01.

export interface PaletteEntry {
  /** Linear RGB, 0..1. */
  r: number;
  g: number;
  b: number;
  /** Radiant intensity multiplier. 0 = not a light. */
  emissive: number;
}

// Named indices used by the Dream 01 room generator and brushes.
export const MAT = {
  EMPTY: 0,
  WALL: 1,
  FLOOR_A: 2,
  FLOOR_B: 3,
  CEILING: 4,
  PILLAR: 5,
  TRIM: 6,
  RUBBLE: 7,
  /** First emissive entry; LIGHT_WARM..LIGHT_WARM+5 are the light hues. */
  LIGHT_WARM: 16,
} as const;

export const LIGHT_COUNT = 6;

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function entry(hex: number, emissive = 0): PaletteEntry {
  return {
    r: srgbToLinear(((hex >> 16) & 0xff) / 255),
    g: srgbToLinear(((hex >> 8) & 0xff) / 255),
    b: srgbToLinear((hex & 0xff) / 255),
    emissive,
  };
}

function hsl(h: number, s: number, l: number): PaletteEntry {
  // Standard HSL→RGB, then to linear. h in [0,1).
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: srgbToLinear(f(0)), g: srgbToLinear(f(8)), b: srgbToLinear(f(4)), emissive: 0 };
}

/**
 * Deterministic default palette:
 *  - 0: empty
 *  - 1..7: the Dream 01 room materials (muted, cool — a room built to be dark)
 *  - 16..21: emissive lights, warm amber first, then a hue wheel
 *  - 32..255: hue×lightness ramps so the palette is fully populated
 */
export function generateDefaultPalette(): PaletteEntry[] {
  const p: PaletteEntry[] = new Array(256);
  for (let i = 0; i < 256; i++) p[i] = { r: 0, g: 0, b: 0, emissive: 0 };

  // Mid-to-light albedos on purpose: the room reads dark because it is
  // UNLIT, not because it is painted black. Dark paint would eat the
  // bounce light and make the Dream 01 GI bloom invisible (the golden
  // test pins this: GI must add >25% energy to the lit room).
  p[MAT.WALL] = entry(0xbcc6d6);
  p[MAT.FLOOR_A] = entry(0xd0c4b0);
  p[MAT.FLOOR_B] = entry(0xb2a68f);
  p[MAT.CEILING] = entry(0xb4bdcd);
  p[MAT.PILLAR] = entry(0xd6bfa8);
  p[MAT.TRIM] = entry(0xdde4f0);
  p[MAT.RUBBLE] = entry(0xc0b4a4);

  // Lights. Warm amber is the Dream 01 tool; the rest unlock with the sandbox.
  const lightHexes = [0xffb36b, 0xff6b5e, 0x7ee787, 0x6bc5ff, 0xc79bff, 0xfff3c4];
  lightHexes.forEach((hex, i) => {
    p[MAT.LIGHT_WARM + i] = entry(hex, 8);
  });

  // Fill 32..255: 14 hues × 16 lightness steps.
  for (let i = 32; i < 256; i++) {
    const idx = i - 32;
    const hue = Math.floor(idx / 16) / 14;
    const lig = 0.15 + (idx % 16) * 0.05;
    p[i] = hsl(hue, 0.45, lig);
  }
  return p;
}

/** Pack the palette for the GPU: 256 × vec4f = (r, g, b, emissive). */
export function paletteToFloat32Array(palette: PaletteEntry[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const e = palette[i] ?? { r: 0, g: 0, b: 0, emissive: 0 };
    out[i * 4 + 0] = e.r;
    out[i * 4 + 1] = e.g;
    out[i * 4 + 2] = e.b;
    out[i * 4 + 3] = e.emissive;
  }
  return out;
}
