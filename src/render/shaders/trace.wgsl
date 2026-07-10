//! # Brickmap path tracer with temporal accumulation
//!
//! One compute thread per pixel traces a full light path through the voxel
//! world every frame, and the result is averaged with previous frames.
//! Three techniques stacked together:
//!
//! ## 1. Two-level DDA traversal (the brickmap)
//! Rays walk the grid with the DDA of Amanatides & Woo, "A Fast Voxel
//! Traversal Algorithm for Ray Tracing" (Eurographics 1987) — cross the
//! nearest cell boundary, repeat. It runs at two scales: first over 8×8×8
//! *bricks* (one bit per brick says "anything in here?"), and only inside
//! occupied bricks over individual voxels (one bit per voxel). Empty space
//! is skipped eight voxels at a stride. This is the same structure the
//! editor stores on the CPU (see src/core/brick.ts), per the brickmap
//! design of van Wingerden's thesis "Real-time Ray tracing and Editing of
//! Large Voxel Scenes" (Utrecht, 2015).
//!
//! ## 2. Path-traced global illumination
//! At each surface hit we do next-event estimation: pick one emissive voxel
//! at random, cast a shadow ray at a jittered point inside it (that jitter
//! is what makes shadows soft), and add its direct contribution. Then the
//! ray bounces in a cosine-weighted random direction and repeats — that
//! bounce is the *indirect* light, the colour that crawls around corners.
//! Emissive voxels are the only light sources; the sky is a whisper.
//!
//! ## 3. Temporal accumulation
//! One noisy sample per pixel per frame, blended into an accumulation
//! buffer: `accum = mix(accum, sample, alpha)`. While the camera is still,
//! `alpha = 1/(N+1)` — an exact running average that converges in about a
//! second. While moving or editing, alpha is floored so the image stays
//! responsive instead of exact.
//!
//! ## Knobs (uniforms)
//! - `alpha` — accumulation blend weight. 1 = discard history, 1/(N+1) =
//!   perfect average. Raise the floor and edits appear faster but noise
//!   never fully settles.
//! - `maxBounces` — indirect bounce count. 0 = direct light only. Each
//!   bounce adds one more "generation" of reflected colour and one more
//!   ray of cost.
//! - `flags` bit 0 — the GI debug switch. Off, you get emission + direct
//!   light + a constant ambient: the "point light with falloff" look.
//!   On, the room answers back.
//! - `lightScale` — global emissive intensity multiplier. Doubling it is
//!   like doubling the wattage of every light in the scene.

const WORLD: i32 = 64;         // world is WORLD^3 voxels
const BRICKS: i32 = 8;         // WORLD / 8 bricks per axis
const FIREFLY_CLAMP: f32 = 14.0;
const PI: f32 = 3.14159265359;

struct Uniforms {
  camPos: vec3f,   frame: u32,
  camRight: vec3f, alpha: f32,
  camUp: vec3f,    lightCount: u32,
  camFwd: vec3f,   flags: u32,
  res: vec2f,      tanHalfFov: f32, maxBounces: u32,
  lightScale: f32, pad0: f32, pad1: f32, pad2: f32,
}

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var<storage, read> brickOcc: array<u32>;  // 1 bit / brick
@group(0) @binding(2) var<storage, read> voxOcc: array<u32>;    // 1 bit / voxel
@group(0) @binding(3) var<storage, read> materials: array<u32>; // 4 palette u8s / word
@group(0) @binding(4) var<storage, read> palette: array<vec4f>; // rgb + emissive
@group(0) @binding(5) var<storage, read> lights: array<vec4f>;  // xyz center, w mat
@group(0) @binding(6) var<storage, read_write> accum: array<vec4f>;

// --- PCG hash (Jarzynski & Olano, JCGT 2020). Twin of src/core/hash.ts. ---
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn randU(seed: ptr<function, u32>) -> u32 {
  *seed = pcg(*seed);
  return *seed;
}

fn randF(seed: ptr<function, u32>) -> f32 {
  return f32(randU(seed)) * 2.3283064365386963e-10; // / 2^32
}

// --- World lookups -------------------------------------------------------
fn voxelIndex(p: vec3i) -> u32 {
  return u32(p.x) + u32(p.y) * 64u + u32(p.z) * 4096u;
}

fn voxelSolid(p: vec3i) -> bool {
  let i = voxelIndex(p);
  return ((voxOcc[i >> 5u] >> (i & 31u)) & 1u) == 1u;
}

fn voxelMat(p: vec3i) -> u32 {
  let i = voxelIndex(p);
  return (materials[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
}

fn brickSolid(b: vec3i) -> bool {
  let i = u32(b.x) + u32(b.y) * 8u + u32(b.z) * 64u;
  return ((brickOcc[i >> 5u] >> (i & 31u)) & 1u) == 1u;
}

// --- Two-level DDA -------------------------------------------------------
struct Hit {
  ok: bool,
  cell: vec3i,
  mat: u32,
  n: vec3f,
  t: f32,
}

fn traceRay(ro: vec3f, rdIn: vec3f, tMax: f32) -> Hit {
  var out: Hit;
  out.ok = false;

  var rd = rdIn;
  if (abs(rd.x) < 1e-6) { rd.x = select(1e-6, -1e-6, rd.x < 0.0); }
  if (abs(rd.y) < 1e-6) { rd.y = select(1e-6, -1e-6, rd.y < 0.0); }
  if (abs(rd.z) < 1e-6) { rd.z = select(1e-6, -1e-6, rd.z < 0.0); }
  let inv = 1.0 / rd;

  // Clip to the world box [0, WORLD]^3.
  let tLo = (vec3f(0.0) - ro) * inv;
  let tHi = (vec3f(f32(WORLD)) - ro) * inv;
  let tMin3 = min(tLo, tHi);
  let tMax3 = max(tLo, tHi);
  let tNear = max(max(tMin3.x, tMin3.y), tMin3.z);
  let tFar = min(min(tMax3.x, tMax3.y), tMax3.z);
  if (tFar < max(tNear, 0.0)) { return out; }
  var t = max(tNear + 1e-4, 0.0);
  if (t > tMax) { return out; }

  // Normal of the world-entry face, if we started outside.
  var lastN = vec3f(0.0);
  if (tNear > 0.0) {
    if (tNear == tMin3.x) { lastN = vec3f(-sign(rd.x), 0.0, 0.0); }
    else if (tNear == tMin3.y) { lastN = vec3f(0.0, -sign(rd.y), 0.0); }
    else { lastN = vec3f(0.0, 0.0, -sign(rd.z)); }
  }

  let stepI = vec3i(sign(rd));
  let stepUp = max(sign(rd), vec3f(0.0)); // 1 where rd>0 else 0

  // Brick-level DDA state: t of the next brick-boundary crossing per axis.
  var p = ro + rd * t;
  var b = clamp(vec3i(floor(p / 8.0)), vec3i(0), vec3i(BRICKS - 1));
  var bNextT = (vec3f(b * 8) + stepUp * 8.0 - ro) * inv;
  let bDelta = abs(inv) * 8.0;

  for (var i = 0; i < 40; i++) {
    if (brickSolid(b)) {
      // Voxel-level DDA inside this brick, resumed at parameter t.
      let q = ro + rd * (t + 1e-4);
      let lo = b * 8;
      var v = clamp(vec3i(floor(q)), lo, lo + vec3i(7));
      var vNextT = (vec3f(v) + stepUp - ro) * inv;
      let vDelta = abs(inv);
      var n = lastN;
      var vt = t;
      for (var j = 0; j < 32; j++) {
        if (voxelSolid(v)) {
          if (vt > tMax) { return out; }
          out.ok = true;
          out.cell = v;
          out.mat = voxelMat(v);
          out.n = n;
          out.t = vt;
          return out;
        }
        if (vNextT.x <= vNextT.y && vNextT.x <= vNextT.z) {
          vt = vNextT.x; vNextT.x += vDelta.x; v.x += stepI.x; n = vec3f(-sign(rd.x), 0.0, 0.0);
        } else if (vNextT.y <= vNextT.z) {
          vt = vNextT.y; vNextT.y += vDelta.y; v.y += stepI.y; n = vec3f(0.0, -sign(rd.y), 0.0);
        } else {
          vt = vNextT.z; vNextT.z += vDelta.z; v.z += stepI.z; n = vec3f(0.0, 0.0, -sign(rd.z));
        }
        if (any(v < lo) || any(v > lo + vec3i(7))) { break; }
      }
    }
    // Step to the next brick.
    if (bNextT.x <= bNextT.y && bNextT.x <= bNextT.z) {
      t = bNextT.x; bNextT.x += bDelta.x; b.x += stepI.x; lastN = vec3f(-sign(rd.x), 0.0, 0.0);
    } else if (bNextT.y <= bNextT.z) {
      t = bNextT.y; bNextT.y += bDelta.y; b.y += stepI.y; lastN = vec3f(0.0, -sign(rd.y), 0.0);
    } else {
      t = bNextT.z; bNextT.z += bDelta.z; b.z += stepI.z; lastN = vec3f(0.0, 0.0, -sign(rd.z));
    }
    if (t > min(tFar, tMax)) { return out; }
    if (any(b < vec3i(0)) || any(b > vec3i(BRICKS - 1))) { return out; }
  }
  return out;
}

// --- Lighting ------------------------------------------------------------
fn sky(rd: vec3f) -> vec3f {
  // A near-black night gradient; only the ceiling crack ever sees it.
  let up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(vec3f(0.010, 0.014, 0.028), vec3f(0.055, 0.075, 0.13), up);
}

// Next-event estimation: sample one emissive voxel, cast one shadow ray.
// Returns incident radiance * cos(theta), already divided by the pick pdf.
fn sampleLights(pos: vec3f, n: vec3f, seed: ptr<function, u32>) -> vec3f {
  if (uni.lightCount == 0u) { return vec3f(0.0); }
  let pick = randU(seed) % uni.lightCount;
  let l = lights[pick];
  let lmat = palette[u32(l.w)];

  // Jitter the sample point inside the light voxel — soft shadows for free.
  let jitter = vec3f(randF(seed), randF(seed), randF(seed)) - 0.5;
  let lp = l.xyz + jitter * 0.9;

  var wi = lp - pos;
  let d2 = max(dot(wi, wi), 0.75);
  let dist = length(wi);
  wi = wi / max(dist, 1e-4);
  let ndotl = dot(n, wi);
  if (ndotl <= 0.0) { return vec3f(0.0); }

  let sh = traceRay(pos + n * 1e-3, wi, dist + 1.0);
  let lightCell = vec3i(floor(l.xyz));
  if (sh.ok && !all(sh.cell == lightCell)) { return vec3f(0.0); } // occluded

  let emitted = lmat.rgb * lmat.a * uni.lightScale;
  return emitted * ndotl / d2 * f32(uni.lightCount);
}

fn cosineHemisphere(n: vec3f, seed: ptr<function, u32>) -> vec3f {
  let r1 = randF(seed);
  let r2 = randF(seed);
  let phi = 2.0 * PI * r1;
  let sr = sqrt(r2);
  let a = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let tang = normalize(cross(a, n));
  let bit = cross(n, tang);
  return normalize(tang * (cos(phi) * sr) + bit * (sin(phi) * sr) + n * sqrt(max(1.0 - r2, 0.0)));
}

// --- Kernel ----------------------------------------------------------------
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(uni.res.x);
  let h = u32(uni.res.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let pixel = gid.y * w + gid.x;
  var seed = pcg(pixel ^ pcg(uni.frame));

  // Jittered primary ray.
  let jit = vec2f(randF(&seed), randF(&seed)) - 0.5;
  let ndc = ((vec2f(gid.xy) + 0.5 + jit) / uni.res) * 2.0 - 1.0;
  let aspect = uni.res.x / uni.res.y;
  var rd = normalize(
    uni.camFwd + uni.camRight * (ndc.x * uni.tanHalfFov * aspect)
               - uni.camUp * (ndc.y * uni.tanHalfFov));
  var ro = uni.camPos;

  var radiance = vec3f(0.0);
  var throughput = vec3f(1.0);
  let giOn = (uni.flags & 1u) == 1u;

  for (var bounce = 0u; bounce <= uni.maxBounces; bounce++) {
    let hit = traceRay(ro, rd, 1e4);
    if (!hit.ok) {
      radiance += throughput * sky(rd);
      break;
    }
    let m = palette[hit.mat];
    if (m.a > 0.0) {
      // Emissive surface. Camera rays see it glow; bounce rays skip it —
      // next-event estimation already counted every light exactly once.
      if (bounce == 0u) { radiance += throughput * m.rgb * m.a; }
      break;
    }

    let albedo = m.rgb;
    let hp = ro + rd * hit.t;

    if (bounce == 0u) {
      // A whisper of ambient so an unlit room is readable at all.
      radiance += albedo * 0.004 * (hit.n.y * 0.3 + 0.7);
    }

    // Direct light (NEE), diffuse BRDF = albedo / pi.
    radiance += throughput * (albedo / PI) * sampleLights(hp, hit.n, &seed);

    if (!giOn || bounce == uni.maxBounces) { break; }

    // Indirect: cosine-weighted bounce; pdf cancels ndotl/pi exactly.
    rd = cosineHemisphere(hit.n, &seed);
    ro = hp + hit.n * 1e-3;
    throughput *= albedo;
  }

  // Firefly clamp: one lucky path must not leave a bright pixel for 100 frames.
  let lum = dot(radiance, vec3f(0.2126, 0.7152, 0.0722));
  if (lum > FIREFLY_CLAMP) { radiance *= FIREFLY_CLAMP / lum; }

  let prev = accum[pixel].rgb;
  accum[pixel] = vec4f(mix(prev, radiance, uni.alpha), 1.0);
}
