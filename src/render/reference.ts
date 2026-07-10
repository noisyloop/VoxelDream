// CPU reference implementation of the Dreaming path tracer.
//
// This mirrors trace.wgsl step for step — same PCG sequences, same NEE +
// cosine-bounce integrator, same sky/ambient/firefly constants — built on
// the tested CPU DDA in core/raycast.ts. It exists for two reasons:
//
//  1. Golden-image tests. CI has no GPU; this renders the same algorithm
//     deterministically so tests can pin a hash of the output and assert
//     physical properties (e.g. "GI adds energy to shadowed regions").
//  2. Ground truth. When the WGSL misbehaves, render the same scene here
//     and diff intent against implementation.
//
// It is deliberately unoptimized and runs on a dense snapshot of the world.
// Not bit-identical to the GPU (float order differs); identical in method.

import { raycast } from "../core/raycast";
import { pcg } from "../core/hash";
import type { PaletteEntry } from "../core/palette";
import type { World } from "../core/world";

const WORLD_SIZE = 64;
const FIREFLY_CLAMP = 14.0;
const LIGHT_SCALE = 50.0; // must match renderer.ts's lightScale uniform
const EXPOSURE = 1.35;

export interface ReferenceOptions {
  width: number;
  height: number;
  /** Samples per pixel (frames of accumulation). */
  spp: number;
  giEnabled: boolean;
  maxBounces?: number;
  camera: { yaw: number; pitch: number; distance: number; target: [number, number, number]; fov: number };
}

interface DenseWorld {
  get(x: number, y: number, z: number): number;
  lights: { x: number; y: number; z: number; mat: number }[];
}

function snapshot(world: World, palette: PaletteEntry[]): DenseWorld {
  const grid = new Uint8Array(WORLD_SIZE ** 3);
  const lights: DenseWorld["lights"] = [];
  world.forEach((x, y, z, mat) => {
    grid[x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE] = mat;
    if ((palette[mat]?.emissive ?? 0) > 0) lights.push({ x, y, z, mat });
  });
  lights.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
  return {
    get(x, y, z) {
      if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE || z >= WORLD_SIZE) return 0;
      return grid[x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE]!;
    },
    lights,
  };
}

/** Render linear HDR radiance (width*height*3). */
export function renderReference(
  world: World,
  palette: PaletteEntry[],
  opts: ReferenceOptions
): Float32Array {
  const { width, height, spp, giEnabled, camera } = opts;
  const maxBounces = opts.maxBounces ?? 3;
  const dense = snapshot(world, palette);

  // Camera basis (same math as render/camera.ts).
  const cp = Math.cos(camera.pitch);
  const pos: V3 = [
    camera.target[0] + camera.distance * cp * Math.sin(camera.yaw),
    camera.target[1] + camera.distance * Math.sin(camera.pitch),
    camera.target[2] + camera.distance * cp * Math.cos(camera.yaw),
  ];
  const fwd = norm(sub(camera.target, pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const tanF = Math.tan(camera.fov / 2);
  const aspect = width / height;

  const out = new Float32Array(width * height * 3);

  for (let frame = 0; frame < spp; frame++) {
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const pixel = py * width + px;
        let seed = pcg((pixel ^ pcg(frame)) >>> 0);
        const rand = () => {
          seed = pcg(seed);
          return seed / 4294967296;
        };

        const ndcX = ((px + 0.5 + rand() - 0.5) / width) * 2 - 1;
        const ndcY = ((py + 0.5 + rand() - 0.5) / height) * 2 - 1;
        let rd = norm([
          fwd[0] + right[0] * ndcX * tanF * aspect - up[0] * ndcY * tanF,
          fwd[1] + right[1] * ndcX * tanF * aspect - up[1] * ndcY * tanF,
          fwd[2] + right[2] * ndcX * tanF * aspect - up[2] * ndcY * tanF,
        ]);
        let ro: V3 = [pos[0], pos[1], pos[2]];

        let radiance: V3 = [0, 0, 0];
        let throughput: V3 = [1, 1, 1];

        for (let bounce = 0; bounce <= maxBounces; bounce++) {
          const hit = raycast(dense, ro[0], ro[1], ro[2], rd[0], rd[1], rd[2], 1e4);
          if (!hit) {
            const skyC = sky(rd);
            radiance = add(radiance, mul(throughput, skyC));
            break;
          }
          const m = palette[hit.mat]!;
          if (m.emissive > 0) {
            if (bounce === 0) {
              radiance = add(radiance, mul(throughput, [m.r * m.emissive, m.g * m.emissive, m.b * m.emissive]));
            }
            break;
          }
          const albedo: V3 = [m.r, m.g, m.b];
          const n: V3 = [hit.nx, hit.ny, hit.nz];
          const hp: V3 = [ro[0] + rd[0] * hit.t, ro[1] + rd[1] * hit.t, ro[2] + rd[2] * hit.t];

          if (bounce === 0) {
            const amb = 0.004 * (n[1] * 0.3 + 0.7);
            radiance = add(radiance, [albedo[0] * amb, albedo[1] * amb, albedo[2] * amb]);
          }

          // NEE
          if (dense.lights.length > 0) {
            seed = pcg(seed);
            const light = dense.lights[seed % dense.lights.length]!;
            const lm = palette[light.mat]!;
            const lp: V3 = [
              light.x + 0.5 + (rand() - 0.5) * 0.9,
              light.y + 0.5 + (rand() - 0.5) * 0.9,
              light.z + 0.5 + (rand() - 0.5) * 0.9,
            ];
            let wi = sub(lp, hp);
            const d2 = Math.max(dot(wi, wi), 0.75);
            const dist = Math.sqrt(dot(wi, wi));
            wi = [wi[0] / dist, wi[1] / dist, wi[2] / dist];
            const ndotl = dot(n, wi);
            if (ndotl > 0) {
              const so: V3 = [hp[0] + n[0] * 1e-3, hp[1] + n[1] * 1e-3, hp[2] + n[2] * 1e-3];
              const sh = raycast(dense, so[0], so[1], so[2], wi[0], wi[1], wi[2], dist + 1.0);
              const visible = !sh || (sh.x === light.x && sh.y === light.y && sh.z === light.z);
              if (visible) {
                const s = (lm.emissive * LIGHT_SCALE * ndotl * dense.lights.length) / d2 / Math.PI;
                radiance = add(radiance, mul(throughput, [albedo[0] * lm.r * s, albedo[1] * lm.g * s, albedo[2] * lm.b * s]));
              }
            }
          }

          if (!giEnabled || bounce === maxBounces) break;

          rd = cosineHemisphere(n, rand);
          ro = [hp[0] + n[0] * 1e-3, hp[1] + n[1] * 1e-3, hp[2] + n[2] * 1e-3];
          throughput = [throughput[0] * albedo[0], throughput[1] * albedo[1], throughput[2] * albedo[2]];
        }

        const lum = radiance[0] * 0.2126 + radiance[1] * 0.7152 + radiance[2] * 0.0722;
        if (lum > FIREFLY_CLAMP) {
          const k = FIREFLY_CLAMP / lum;
          radiance = [radiance[0] * k, radiance[1] * k, radiance[2] * k];
        }

        // Running average, exactly the alpha = 1/(N+1) policy.
        const a = 1 / (frame + 1);
        out[pixel * 3 + 0] = out[pixel * 3 + 0]! + (radiance[0] - out[pixel * 3 + 0]!) * a;
        out[pixel * 3 + 1] = out[pixel * 3 + 1]! + (radiance[1] - out[pixel * 3 + 1]!) * a;
        out[pixel * 3 + 2] = out[pixel * 3 + 2]! + (radiance[2] - out[pixel * 3 + 2]!) * a;
      }
    }
  }
  return out;
}

/** Tonemap HDR to display RGBA, same chain as blit.wgsl (minus vignette). */
export function tonemap(hdr: Float32Array): Uint8ClampedArray {
  const n = hdr.length / 3;
  const out = new Uint8ClampedArray(n * 4);
  const aces = (x: number) =>
    Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  const srgb = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = srgb(aces(hdr[i * 3 + c]! * EXPOSURE)) * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function sky(rd: V3): V3 {
  const up = Math.min(Math.max(rd[1] * 0.5 + 0.5, 0), 1);
  return [
    0.01 + (0.055 - 0.01) * up,
    0.014 + (0.075 - 0.014) * up,
    0.028 + (0.13 - 0.028) * up,
  ];
}

function cosineHemisphere(n: V3, rand: () => number): V3 {
  const r1 = rand();
  const r2 = rand();
  const phi = 2 * Math.PI * r1;
  const sr = Math.sqrt(r2);
  const a: V3 = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const tang = norm(cross(a, n));
  const bit = cross(n, tang);
  const z = Math.sqrt(Math.max(1 - r2, 0));
  return norm([
    tang[0] * Math.cos(phi) * sr + bit[0] * Math.sin(phi) * sr + n[0] * z,
    tang[1] * Math.cos(phi) * sr + bit[1] * Math.sin(phi) * sr + n[1] * z,
    tang[2] * Math.cos(phi) * sr + bit[2] * Math.sin(phi) * sr + n[2] * z,
  ]);
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, b: V3): V3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
