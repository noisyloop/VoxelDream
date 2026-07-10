# VoxelDream

A browser-based voxel world builder that teaches computer graphics by making
you earn every tool you use. A Metroidvania whose power-ups are creative
competencies; underneath, a serious voxel editor with a real path-traced
renderer and honest export targets.

**Status: Milestone 0 — the vertical slice.** One dream, one brush, one
exporter. See [SPEC.md](SPEC.md) for the full design and
[RESEARCH.md](RESEARCH.md) for the technique research that gates the renderer.

## Run it

```sh
npm install
npm run dev     # needs a WebGPU browser: Chrome/Edge 113+, Safari 18+, Firefox 141+
npm test        # zero-binary gate + unit + golden tests (no GPU needed)
npm run build   # gate + typecheck + production build
```

## Dream 01: Light

You wake in a dark 64³ chamber, generated procedurally at load. You hold one
light. Click to let it go.

The moment it lands, the path tracer shows you what no tooltip could: the
glow on the far wall that your light never touched — bounced illumination,
the room answering back. That's the lesson. Completing it unlocks the
emissive brush in a bare sandbox (place, erase, orbit, six hues) and one
button: **Export as shader**, which bakes your room into a self-contained
`.glsl` file that runs unmodified as a Shadertoy Image shader.

Controls: drag to orbit, wheel to dolly, click to place/erase,
Ctrl+Z / Ctrl+Shift+Z for undo/redo (sandbox), Esc closes the code panel.
The **bounce light (GI)** checkbox in the corner is the debug flag from the
SPEC: turn it off and the room collapses to a point light with falloff.

## How it works

- **Renderer** (`src/render/`): hand-written WGSL, no three.js. One compute
  pass path-traces the brickmap — two-level Amanatides–Woo DDA over 8³-brick
  occupancy bits, then per-voxel bits — with next-event estimation against
  the emissive voxel list and cosine-weighted bounces. Accumulation is
  `alpha = 1/(N+1)` while still (converges in ~1 s), floored + half-res
  while moving, and *clamped, not reset* on edits so stamps reconverge
  without dropping the frame to noise. A blit pass upscales, ACES-tonemaps
  and sRGB-encodes.
- **Every shader explains itself**: `.wgsl` files start with a `//!` doc
  header (technique, reference, knobs). A Vite plugin parses headers at
  build time — a missing header is a build error — and the in-app
  "show me the code" panel renders them next to the live source.
- **World** (`src/core/`): sparse 32³ chunks of 8³ bricks, occupancy
  bitmasks kept in sync with palette-indexed materials, brick-granular
  dirty tracking, command-pattern undo history.
- **Exporter** (`src/export/shader.ts`): Shadertoy has no custom texture
  upload and a ~2–8 KB const-data budget, so the export embeds the *room
  generator* (a GLSL twin of `roomVoxel`/`pcg`) plus a sorted,
  binary-searched uint diff of your edits — data scales with what you
  changed, not with world size.
- **Zero binary assets**: `scripts/check-no-binaries.mjs` fails the build on
  any tracked file outside a text-extension allowlist or containing NUL
  bytes. Icons are inline SVG path strings, sounds are Web Audio oscillator
  graphs, the palette and the room are generator functions.

## Testing

`npm test` runs on plain Node — no GPU:

- unit tests for bricks/world/history/DDA/hash/palette;
- golden-hash tests (the hash is pinned, never an image file) for the room
  generator, palette, emitted GLSL, and the GI integrator;
- the GI goldens run `src/render/reference.ts`, a CPU mirror of
  `trace.wgsl` on the same PCG sequences, and assert the physics: bounced
  light adds >25% total energy, and the darkest tenth of the direct-only
  frame more than doubles with GI on.

Milestone 0 was additionally validated end-to-end in headless Chromium
(WebGPU via SwiftShader): boot at 60 fps, click-to-place progression,
sandbox unlock, doc-header panel, and the exported GLSL compiled and
rendered under Shadertoy's exact WebGL2 wrapper. Two caveats from that run,
recorded honestly: GPU readback (`mapAsync`) is broken in that SwiftShader
build, so the GI on/off evidence images come from the CPU reference
renderer; and the final "paste into shadertoy.com" acceptance check is
manual by design — do it when you ship.

## Milestone 0 scope

Built: the Dreaming renderer, Dream 01, the emissive brush, the shader
exporter, the doc-header pipeline, the zero-binary CI gate.
Deliberately not built yet (see SPEC "resist scope"): the Waking
greedy-mesh mode and WebGL2 fallback, other brushes/dreams/exporters, the
falling-sand sim, reprojection/SVGF denoising (researched and specced in
RESEARCH.md §1.3 as the first Milestone 1 renderer task).
