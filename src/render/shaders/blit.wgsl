//! # Present pass: upscale, tonemap, encode
//!
//! The path tracer accumulates linear-light HDR radiance in a storage
//! buffer at an internal resolution (which drops while the camera moves).
//! This pass stretches that buffer to the canvas and makes it displayable:
//!
//! - **Upscale** — nearest-neighbour fetch from the accumulation grid.
//!   Deliberately unfiltered: during motion you can *see* the renderer
//!   trade resolution for speed, which is honest and pedagogically useful.
//! - **Tonemap** — the ACES filmic approximation (Krzysztof Narkowicz,
//!   "ACES Filmic Tone Mapping Curve"). Maps unbounded HDR radiance into
//!   [0,1] with a gentle shoulder, so an emissive voxel reads as "bright"
//!   instead of clipping to flat white.
//! - **Vignette** — a slight radial darkening. Pure theatre for the dream
//!   mood; delete one line to remove it.
//! - **sRGB encode** — the accumulation buffer is linear; the swapchain
//!   expects display-encoded values, so we apply the standard transfer
//!   function at the very end. Do all math in linear, encode once.
//!
//! ## Knobs
//! - `exposure` (constant below) — linear multiplier before the tonemap.
//! - The vignette strength is the `0.25` in the fragment shader.

struct Uniforms {
  camPos: vec3f,   frame: u32,
  camRight: vec3f, alpha: f32,
  camUp: vec3f,    lightCount: u32,
  camFwd: vec3f,   flags: u32,
  res: vec2f,      tanHalfFov: f32, maxBounces: u32,
  lightScale: f32, fullResX: f32, fullResY: f32, pad2: f32,
}

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;

const EXPOSURE: f32 = 1.35;

struct VSOut {
  @builtin(position) pos: vec4f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  // One triangle that covers the screen; no vertex buffer needed.
  var out: VSOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  return out;
}

fn aces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn srgb(x: vec3f) -> vec3f {
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let fullRes = vec2f(uni.fullResX, uni.fullResY);
  let uv = in.pos.xy / fullRes;
  let ip = vec2u(clamp(uv * uni.res, vec2f(0.0), uni.res - 1.0));
  var c = accum[ip.y * u32(uni.res.x) + ip.x].rgb;

  c *= EXPOSURE;
  c = aces(c);

  let v = uv - 0.5;
  c *= 1.0 - 0.25 * dot(v, v) * 2.0;

  return vec4f(srgb(c), 1.0);
}
