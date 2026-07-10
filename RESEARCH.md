# RESEARCH.md

Produced by the research phase mandated in SPEC.md, before renderer work began.
This is a living record: when practice contradicts a recommendation here, the
deviation gets written back into this file in the same commit.

## Executive summary — what Milestone 0 actually implements

| Question | Decision | Why |
|---|---|---|
| GI for the 64³ room | **Progressive path tracing + temporal accumulation** (1 spp/frame, NEE + one cosine bounce), not radiance cascades, not DDGI | Zero auxiliary structure, ground-truth converged result, edits are nearly free. RC/DDGI math below shows they only pay off at ≥512³, and 3D world-space RC doesn't pay off even there. |
| Traversal | **Two-level DDA over a brickmap**: 8³-brick occupancy mask grid, then per-voxel occupancy bitmasks (16×u32 per brick) | The XBrickMap/van-Wingerden family wins the only good public benchmark on integrated GPUs *and* is O(1)-editable. ESVO rejected: slower and edit-hostile. |
| Accumulation during motion | Sample-count accumulation `α = max(1/(N+1), α_min)`; on camera motion, N resets and internal render scale drops; on **edit**, N clamps to a small value instead of resetting | Meets "converge ~1 s after stopping" and "edits reconverge without resetting to noise". Full G-buffer reprojection + neighborhood clamp is the documented upgrade path (see §3), deliberately deferred past M0. |
| Randomness | PCG hash (Jarzynski–Olano) computed on the fly, no permutation tables, no blue-noise texture yet | Best quality/speed in the JCGT survey; WGSL-trivial. Owen-scrambled Sobol and boot-time void-and-cluster blue noise are the upgrade path. |
| Shadertoy export | **Procedural-twin + diff**: emit a GLSL copy of the deterministic room generator plus a sorted, binary-searched `const uint` array of user edits; palette as a `switch` | Shadertoy's real const-array budget is ~2–8 KB before ANGLE converts arrays to uniform components and compiles die. A raw 64³ grid (32 KB occupancy alone) does not fit; the diff does. |
| SPEC deviation | SPEC says export "bakes the 64³ world into a 3D texture". Shadertoy offers **no custom texture upload**, so a literally-baked texture cannot be "self-contained and unmodified on Shadertoy". The bake is instead into *code* (generator + diff). | Recorded here per the working agreement. The in-app renderer still uploads the world as GPU buffers; only the export target changed representation. |

Everything below is the full research record with sources.

---

## 1. Rendering

### 1.1 Radiance cascades

**Primary sources.** Alexander Sannikov's working paper is public at
[Raikiri/RadianceCascadesPaper](https://github.com/Raikiri/RadianceCascadesPaper/blob/main/RadianceCascades.tex).
Core idea (the "penumbra condition"): resolving radiance needs high *spatial*
resolution near a surface and high *angular* resolution far from it, so the
radiance field is decomposed into distance-banded intervals; each cascade
doubles probe spacing, doubles interval range, halves angular step. RC is
single-shot — no temporal reuse, no bilateral filtering. The shipped
implementation (Path of Exile 2) is **screen-space**, populated by
screen-space raymarching.

Best write-ups and reference implementations:
- [GM Shaders: Radiance Cascades](https://mini.gmshaders.com/p/radiance-cascades) and [part 2](https://mini.gmshaders.com/p/radiance-cascades2) (bilinear fix, pre-averaging, direction-first layout); code at [Yaazarai/RadianceCascades](https://github.com/Yaazarai/RadianceCascades)
- [radiance.wiki](https://radiance.wiki/), [MΛX: Fundamentals of RC](https://m4xc.dev/articles/fundamental-rc/), [jason.today/rc](https://jason.today/rc), [tmpvar's playground](https://tmpvar.com/poc/radiance-cascades/)
- fad's reference 2D Shadertoy: [mtlBzX](https://www.shadertoy.com/view/mtlBzX)
- 3D attempts (all experimental): [tmpvar/radiance-cascades-3d-grid](https://github.com/tmpvar/radiance-cascades-3d-grid), [JTLee98/RadianceCascadesVK3D](https://github.com/JTLee98/RadianceCascadesVK3D), [CodyJasonBennett/three-rc](https://github.com/CodyJasonBennett/three-rc) (screen-space probes + world-space intervals, runs in a browser), [Shadertoy X3XfRM](https://www.shadertoy.com/view/X3XfRM)
- The Chalmers MSc thesis ["Exploration and Optimization of Radiance Cascades"](https://odr.chalmers.se/items/3ee9fb4e-1880-46c2-802a-a660e38dc9ee) states plainly that a world-space 3D probe grid "scales as the size of the scene cubed".

**Memory math at 512³** (8 B/direction entry, RGBA16F radiance+visibility;
total across cascades ≈ 2× cascade 0 because `M_i = M_0 / 2^i` in 3D):

| Cascade-0 spacing | Cascade-0 probes | Dirs/probe | Cascade 0 | Total |
|---|---|---|---|---|
| 1 voxel | 512³ = 134.2M | 8 | **8.6 GB** | ~17.2 GB |
| 2 voxels | 256³ | 8 | 1.07 GB | ~2.1 GB |
| 4 voxels | 128³ | 16 | 268 MB | ~537 MB |
| 8 voxels | 64³ | 16 | 33.6 MB | ~67 MB |

Memory survives at ≥8-voxel spacing, but two things kill world-space 3D RC:
(1) at that spacing you lose exactly the contact-scale GI that is RC's selling
point; (2) a full rebuild traces `≈ 2·P₀·q₀` intervals — ~8.4M at 8-voxel
spacing, 67M at 4 — against measured integrated-GPU brickmap throughput of
~90–165 Mrays/s, i.e. 50–90+ ms per rebuild before shading a single pixel.

**Alternatives.**
- **DDGI** (Majercik et al., [JCGT 2019](https://www.jcgt.org/published/0008/02/01/paper-lowres.pdf); [RTXGI docs](https://github.com/NVIDIAGameWorks/RTXGI-DDGI/blob/main/docs/DDGIVolume.md)): octahedral irradiance probes + filtered-distance visibility (Chebyshev) to stop leaks; ~1.3 kB/probe → a 32³ probe grid over 512³ ≈ 43 MB; update cost decoupled from resolution; edit-friendly. Diffuse-only, hysteresis lag.
- **VXGI / voxel cone tracing** (Crassin et al. 2011, [paper](https://research.nvidia.com/sites/default/files/publications/GIVoxels-pg2011-authors.pdf)): tempting since our scene is already voxels, but anisotropic mips at 512³ ≈ 0.5–1 GB, plus documented leaking/banding.
- **Progressive path tracing + temporal accumulation**: no auxiliary structure (~50 MB of screen buffers at 1080p), cost scales with pixels × bounces not world size, edits are free apart from history invalidation, converges to ground truth.

**RECOMMENDATION.** *(a)* For the 64³ milestone: **progressive path tracing
with temporal accumulation** — a 64³ room traces far above the benchmark
scenes' throughput, so 1 spp primary + NEE + one bounce fits an integrated-GPU
16 ms budget, and ~60 accumulated frames ≈ 1 s gives clean convergence. This
also builds the exact machinery (accumulation, invalidation) every later GI
technique sits on. *(b)* At 512³: keep the path tracer as the base; if a cache
is needed, use sparse DDGI-style probes (8–16 voxel spacing, ~40–340 MB) or
screen-space RC with world-space intervals (three-rc style). **Do not build a
world-space 3D RC grid** — at feasible spacings it is a worse DDGI.
*Followed in M0: yes.*

### 1.2 Brickmap / sparse voxel DDA traversal

**Lineage.**
- Baseline DDA: Amanatides & Woo 1987, ["A Fast Voxel Traversal Algorithm"](http://www.cse.yorku.ca/~amana/research/grid.pdf); annotated overview by [cgyurgyik](https://github.com/cgyurgyik/fast-voxel-traversal-algorithm/blob/master/overview/FastVoxelTraversalOverview.md). Flat DDA alone: ~400–500 steps/ray on big scenes.
- ESVO: Laine & Karras, [I3D 2010](https://research.nvidia.com/sites/default/files/pubs/2010-02_Efficient-Sparse-Voxel/laine2010i3d_paper.pdf). Built for static content; stack-based ascend/descend.
- **The brickmap reference**: Thijs van Wingerden, ["Real-time Ray tracing and Editing of Large Voxel Scenes"](https://studenttheses.uu.nl/handle/20.500.12932/20460) (MSc thesis, Utrecht 2015) — coarse grid of pointers to raw 8³ bricks, designed explicitly for *editing without preprocessing*. Known GPU implementation: [stijnherfst/BrickMap](https://github.com/stijnherfst/BrickMap) (index pools, streaming flags). Rundown: [uygarb.dev](https://uygarb.dev/posts/0003_brickmap_rundown/).
- **Current best public comparison**: dubiousconst282, ["A guide to fast voxel ray tracing using sparse 64-trees"](https://dubiousconst282.github.io/2024/10/03/voxel-ray-tracing/) + [VoxelRT benchmarks](https://github.com/dubiousconst282/VoxelRT). Tricks that matter: AABB ray-march instead of classic DDA bookkeeping, octant mirroring (+10%), 2³ empty-space coalescing via bitmask test (+21%), robust stepping by clamping to the neighbor cell instead of epsilon nudges.
- Tutorial-grade: Jacco Bikker's [voxel ray tracing series](https://jacco.ompf2.com/2024/04/24/ray-tracing-with-voxels-in-c-series-part-1/).

**Measured throughput (VoxelRT, integrated GPU):**

| Scene | PlainDDA | MultiDDA | XBrickMap | ESVO | Tree64 |
|---|---|---|---|---|---|
| Sponza 2k | 31.4 | 147.7 | 165.6 | 95.0 | 182.6 Mrays/s |
| Bistro 4k | 27.7 | 79.3 | 109.6 | 67.9 | 109.7 |
| Bistro 4k +1 bounce | 4.4 | 41.3 | 87.0 | 52.5 | 92.6 |

Read: ESVO loses to simple hierarchical grids by up to ~60%; occupancy-bitmask
marching keeps 76–89% of throughput on incoherent bounce rays; distance fields
have 0.5–3 s build costs — disqualified for live editing. Production sanity
check: [Teardown](https://juandiegomontoya.github.io/teardown_breakdown.html)
ships mip-accelerated DDA over 3D textures with packed 2×2×2 occupancy bits, on
OpenGL 3.3 fragment shaders.

**WebGPU constraints.** No bindless ([wgpu#3637](https://github.com/gfx-rs/wgpu/issues/3637))
→ flat u32-indexed storage buffers, not per-brick textures. Default
`maxStorageBufferBindingSize` = 128 MiB ([webgpufundamentals](https://webgpufundamentals.org/webgpu/lessons/webgpu-storage-buffers.html))
→ a 512³ world (128 MiB brick pool + 16 MiB masks worst case) fits default
limits. No u64 in WGSL → 512-bit brick masks live as 16×u32, popcount via
`countOneBits`.

**RECOMMENDATION.** Two/three-level brickmap with occupancy bitmasks —
chunk grid → brick presence mask → 8³ brick pool of u8 palette indices —
which is exactly the storage layout in `src/core`. Skip ESVO entirely.
*Followed in M0: yes — trace.wgsl runs a two-level DDA (8³ brick-mask grid,
then per-voxel bits) over storage buffers. The fancier AABB-march tricks
(octant mirroring, coalescing) are deferred; a 64³ room doesn't need them.*

### 1.3 Temporal accumulation + reprojection

**Minimum viable pipeline** (sources: [Wisp: temporal accumulation](https://teamwisp.github.io/research/temporal_accumulation.html),
[Alain Galvan: ray tracing denoising](https://alain.xyz/blog/ray-tracing-denoising),
[SVGF](https://research.nvidia.com/publication/2017-07_spatiotemporal-variance-guided-filtering-real-time-reconstruction-path-traced),
[Teardown frame breakdowns](https://acko.net/blog/teardown-frame-teardown/)):

1. 1 spp/frame, demodulated (filter irradiance, multiply albedo back).
2. **Hybrid accumulation**: per-pixel sample count N, `α = max(1/(N+1), α_min)`
   with α_min ≈ 0.1–0.2 — sample-counting when still (exact convergence),
   EMA when things change.
3. Reprojection against a previous-frame depth+normal G-buffer, with
   depth/normal rejection; disocclusion → N=0 plus a stronger spatial filter
   for low-N pixels (this is SVGF's core).
4. **Ghosting on edits**: camera reprojection can't know a voxel changed.
   Mitigations: neighborhood min/max clamping (Teardown's main weapon),
   explicit invalidation from the dirty-brick set (we already track it),
   reactive masks.
5. **Firefly clamping** per sample before accumulation (Unreal exposes this
   as "Max Path Intensity"), plus NEE so bright paths are found by sampling
   rather than luck.

Hobby tracers use `lerp(prev, cur, 1/(frame+1))` with full reset on motion —
fine for a demo, not a shipping renderer.

**RECOMMENDATION.** The full list: demodulated 1 spp → hybrid N-count
accumulation → G-buffer reprojection → neighborhood clamp → per-brick version
invalidation → firefly clamp → à-trous spatial pass scaled by 1/N.

*Followed in M0: partially — deliberate scope cut, recorded per the working
agreement.* M0 implements: hybrid N-count accumulation with α_min EMA floor,
firefly clamping, NEE, and **edit-clamped invalidation** (an edit clamps N to a
small value instead of zeroing it, so stamps reconverge in ~0.2 s without
resetting to noise; this is what the SPEC's "graceful invalidation" clause
needs at 64³). During camera motion M0 drops internal render scale and leans
on the EMA floor instead of reprojecting — at one bounce in a 64³ room the
in-motion noise is acceptable and the fps requirement is met. Full
reprojection + neighborhood clamp + à-trous is the first renderer task of
Milestone 1, and this section is its spec.

### 1.4 Greedy meshing + vertex AO (Waking mode — not built in M0)

Canonical: Mikola Lysenko, [Meshing in a Minecraft Game (0fps 2012)](https://0fps.net/2012/06/30/meshing-in-a-minecraft-game/)
(+ reference JS: [roboleary/GreedyMesh](https://github.com/roboleary/GreedyMesh)) and
[Ambient occlusion for Minecraft-like worlds (0fps 2013)](https://0fps.net/2013/07/03/ambient-occlusion-for-minecraft-like-worlds/).
Modern implementation: [cgerikj/binary-greedy-meshing](https://github.com/cgerikj/binary-greedy-meshing)
(bitwise meshing, 50–200 µs per 64³ chunk single-threaded — per-edit remeshing is trivially real-time).

The three rules that make it look right:
1. Vertex AO: `vertexAO(side1, side2, corner) = (side1 && side2) ? 0 : 3 - (side1+side2+corner)`.
2. Quad-flip fix: split each quad along the diagonal chosen by
   `a00 + a11 > a01 + a10` or AO interpolation goes anisotropic.
3. Greedy merging may only join faces with identical `(material, AO×4)`
   tuples — merges still work because AO is constant along runs away from
   geometry changes.

T-junctions: render quads ~1px expanded rather than stitching. With
palette-indexed voxels, consider meshing occupancy-only and fetching material
per-fragment ([VoxelRT](https://github.com/dubiousconst282/VoxelRT) saw greedy
merge rates collapse to ~15% savings with many materials).

**RECOMMENDATION.** Binary greedy meshing over the existing brick occupancy
bitmasks + 0fps vertex AO, quads packed to 8 bytes, vertex pulling.
*Not built in M0 (Waking mode is Milestone 1+); recorded so the meshed mode
starts from settled tech.*

---

## 2. Formats

### 2.1 MagicaVoxel .vox

Spec: [MagicaVoxel-file-format-vox.txt](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox.txt)
and the [extension doc](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox-extension.txt);
reference parser [ogt_vox.h](https://github.com/jpaver/opengametools/blob/master/src/ogt_vox.h).

- RIFF-style chunks: `id[4] + int32 contentBytes + int32 childBytes`, all
  little-endian; `MAIN` is root, everything else its children. Accept file
  versions **150 and 200** (current MagicaVoxel writes 200; ogt_vox accepts
  exactly these two); write 150.
- `SIZE` (x, y, z int32; z is "gravity direction" → **Z-up right-handed**;
  glTF conversion is `(x, z, -y)`), `XYZI` (n × 4 bytes x,y,z,colorIndex),
  `RGBA` (256×4 bytes).
- **The +1 gotcha**: "color [0-254] are mapped to palette index [1-255]" —
  file RGBA entry 0 is palette slot 1. The single most common interop bug.
  Default palette is a literal `unsigned int[256]` of 0xAABBGGRR in the spec.
- `MATL`: material_id + DICT (`_type` ∈ `_diffuse/_metal/_glass/_emit` plus
  undocumented `_blend/_media`); DICT values are STRINGs (int32 len, no NUL).
- Scene graph `nTRN/nGRP/nSHP`: transform→(group|shape) tree, root transform
  id 0; `_r` is one byte packing a signed permutation matrix; `_t` is a
  translation encoded *as a string* ("1 2 3"). Also `LAYR`, `rOBJ`, `NOTE`,
  `IMAP`.
- Per-model size cap: 256 (XYZI coords are bytes); big scenes = multiple
  models + scene graph.

**RECOMMENDATION.** Chunk-generic reader (skip unknown chunks by N+M),
palette offset handled only at the I/O boundary, preserve unknown chunks/DICT
keys for round-trip. Z-up conversion at the export boundary.

### 2.2 glTF 2.0 / GLB

Spec: [§4.4 GLB layout](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout).
12-byte header (`glTF`, version 2, total length) + chunks
(uint32 len + uint32 type + data): JSON chunk first (pad with 0x20), BIN
second (pad with 0x00), everything 4-byte aligned; buffer 0 with no `uri` =
the BIN chunk. Vertex attributes 4-byte aligned (normalized-ubyte VEC3 color
needs stride 4).

Palette options: (a) tiny palette texture (16×16, NEAREST, UVs at texel
centers) — what MagicaVoxel/vengi do ([vengi#402](https://github.com/vengi-voxel/vengi/issues/402)),
renders correctly in every consumer; (b) 256 materials — kills batching,
nobody ships it; (c) COLOR_0 vertex colors — compact but "colors vanish" the
moment a Unity user swaps materials.

**RECOMMENDATION.** Palette texture (16×16, generated at export time — not a
repo asset), single primitive, roughness 1 metallic 0, optional
`KHR_materials_unlit`; COLOR_0 as secondary option. Validate against the
[Khronos validator](https://github.khronos.org/glTF-Validator/).

### 2.3 USDZ

Spec: [Pixar usdz spec](https://openusd.org/release/spec_usdz.html) — a
**zero-compression, unencrypted zip** whose entries each start on a 64-byte
boundary (padding smuggled into each zip entry's extra field); first file must
be the default USD layer.

**Answer to the critical question:** modern AR Quick Look consumes **usda
(text) inside usdz**. Proof by production use: three.js's
[USDZExporter](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/exporters/USDZExporter.js)
emits pure-text usda + PNG textures, zipped stored with fflate using the
extra-field alignment trick ([fflate#39](https://github.com/101arrowz/fflate/issues/39#issuecomment-777263109)),
and is widely used for iOS "view in AR". The "usdc only" restriction was the
iOS 12 era and survives in stale guides. So yes: **emittable from the browser
with no native toolchain** (~a zip writer + string building). Serve as
`model/vnd.usdz+zip` behind `<a rel="ar">`; ARKit units are meters.

**RECOMMENDATION.** three.js-style text usda + stored zip + 64-byte
alignment; `displayColor` primvar *and* a textured UsdPreviewSurface.

### 2.4 STL

Binary: 80-byte header (**must not start with "solid"** — readers sniff it
for ASCII STL) + uint32 count + n × 50-byte records (float32 normal, 3×
float32 vertices, uint16 attribute = 0); size must equal `84 + 50n`. Unitless
— expose mm-per-voxel.

What the mesher must guarantee ([spec/wiki](https://en.wikipedia.org/wiki/STL_(file_format)),
[Hubs repair guide](https://www.hubs.com/knowledge-base/fixing-most-common-stl-file-errors/)):
outward normals agreeing with CCW winding; the vertex-to-vertex rule (no
T-junctions — **greedy meshing violates it**, so the STL path uses a naive
per-face mesher with interior-face culling); watertightness (every edge shared
by exactly two opposite-direction faces). The classic voxel diagonal (4 quads
sharing an edge) is genuinely non-manifold; slicers usually cope, validators
complain; standard fix is an epsilon edge-split or a warning toggle.

**RECOMMENDATION.** Naive culled-face mesher for STL (extra triangles are
free to slicers), exact integer×scale coordinates, epsilon-split or warn on
diagonal contacts, assert `fileSize === 84 + 50n` in tests.

### 2.5 Shadertoy export target

Contract ([official howto](https://www.shadertoy.com/howto)): implement
`void mainImage(out vec4 fragColor, in vec2 fragCoord)`; Shadertoy injects
`#version 300 es`, precision, uniforms (`iResolution`, `iTime`, `iMouse`,
`iFrame`, …) and `main()` — the export must declare **none** of those.
Channels only bind Shadertoy's own assets — **no custom texture upload**,
which is why the world must be embedded in code.

**The real limit on embedded data** ([shadertoyunofficial on compilation errors](https://shadertoyunofficial.wordpress.com/2018/03/26/puzzling-compilation-errors-in-shadertoy/),
[on compiler crashes](https://shadertoyunofficial.wordpress.com/2017/11/19/avoiding-compiler-crash-or-endless-compilation/)):
drivers (especially ANGLE→D3D) spill large `const` arrays into the default
uniform block and hit `GL_MAX_FRAGMENT_UNIFORM_COMPONENTS` (~1024–4096 vec4s);
before the hard error come minutes-long compiles. Practical budget:
**~2–8 KB of packed data** (≤ ~512–2048 uints). A raw 64³ world (32 KB
occupancy + 256 KB materials) is far outside it. Standard techniques:
bit-packing into uint literals (the textureless-font trick), uvec4 packing,
Buffer-A decode at `iFrame==0` (needs multi-tab paste — rejected: SPEC says
"runs unmodified"), sparse/RLE.

**RECOMMENDATION (implemented).** Since the room is generated by a
deterministic integer-hash function, the export embeds *the generator, not
the data*: a GLSL twin of `roomVoxel()`/`pcg()` plus a sorted `const uint`
array of user edits (1 uint each: 18-bit position + 8-bit material), looked
up by binary search inside the DDA. Data cost scales with what the user
changed, not with world size; a heavily-edited scene warns past ~1500 edits.
Emissive voxels double as the export's light list (capped, brightest first).

---

## 3. Simulation (Milestone 1+; researched now because sim rules shape the brick layout)

**GPU falling sand.** Noita's CPU scheme (64×64 chunks, 4-pass checkerboard,
[80.lv writeup](https://80.lv/articles/noita-a-game-based-on-falling-sand-simulation))
doesn't port: naive double-buffered GPU sand races on diagonal moves (two
cells move into the same destination; matter duplicates or vanishes).

The standard GPU answer is **Margolus / block cellular automata**
([Wikipedia](https://en.wikipedia.org/wiki/Block_cellular_automaton)): partition
into disjoint 2×2×2 blocks, update each block atomically by one thread —
race-free by construction, mass-conserving, **single-buffer, in-place, one
dispatch per step**. Alternate the partition offset so information crosses
block borders; pure two-offset alternation has directional bias, fixed by
cycling a shuffled sequence of the 8 corner offsets (the 3D analog of
[GelamiSalami/GPU-Falling-Sand-CA](https://github.com/GelamiSalami/GPU-Falling-Sand-CA)'s
4-step z-pattern; see also [ARez2/sandengine](https://github.com/ARez2/sandengine)'s
direction-mirroring). Checkerboard multi-pass costs 2–8 dispatches and is
better for chunk scheduling than cell movement; atomics are nondeterministic
under contention; per-brick serial passes waste the GPU.

**RECOMMENDATION.** 2×2×2 Margolus in WGSL compute: one thread per block,
`@workgroup_size(4,4,4)` = 64 blocks = exactly one 8³ brick at offset 0;
rules as swaps with per-block PCG tie-breaking; per-brick dirty flags to skip
settled bricks.

---

## 4. Procedural asset generation

### 4.1 Noise in WGSL

- WGSL implementations to port from/check against: [munrocket's WGSL noise gist](https://gist.github.com/munrocket/236ed5ba7e409b8bdf1ff6eca5dcdc39)
  (⚠ WGSL `%` truncates toward zero, GLSL `mod` floors — the classic silent
  porting bug), [noisy_bevy](https://github.com/johanhelsing/noisy_bevy),
  [LYGIA's WGSL modules](https://github.com/patriciogonzalezvivo/lygia) (best
  Worley source), originals: [stegu/webgl-noise](https://github.com/ashima/webgl-noise),
  [IQ on domain warping](https://iquilezles.org/articles/warp/).
- **Hash on the fly, not permutation tables**: Gustavson & McEwan
  ([JGT 2012](https://arxiv.org/pdf/1204.1461)) showed computed noise scaling
  better every GPU generation; binding LUT textures into every WGSL pipeline
  is pure friction. Hash choice: **PCG family** per Jarzynski & Olano,
  ["Hash Functions for GPU Rendering" (JCGT 2020)](https://jcgt.org/published/0009/03/02/paper.pdf)
  ([Reed's summary](https://www.reedbeta.com/blog/hash-functions-for-gpu-rendering/)).
  Never `fract(sin(x)*43758.5453)` — broken on mobile precision.
- Simplex patent [US6867776](https://patents.google.com/patent/US6867776B2/en)
  **expired 2022-01-08**; 3D/4D simplex is unencumbered.

*M0 uses exactly this: `pcg()` in `src/core/hash.ts` and its WGSL/GLSL twins.*

### 4.2 Blue noise

Void-and-cluster (Ulichney 1993; [demofox implementation](https://blog.demofox.org/2019/06/25/generating-blue-noise-textures-with-void-and-cluster/))
is GPU-feasible at boot: [Alister Chowdhury's WebGL2 generator](https://alister-chowdhury.github.io/posts/20221230-bluenoise-generator/),
[Shadertoy cdfSD8](https://www.shadertoy.com/view/cdfSD8), [Tellusim compute version](https://tellusim.com/improved-blue-noise/) —
64×64 well under a second on GPU. Cheap no-texture alternatives:
**Interleaved Gradient Noise** (Jimenez; [demofox analysis](https://blog.demofox.org/2022/01/01/interleaved-gradient-noise-a-different-kind-of-low-discrepancy-sequence/)),
[R2 sequence](https://extremelearning.com.au/unreasonable-effectiveness-of-quasirandom-sequences/),
**Owen-scrambled Sobol** (Burley, [JCGT 2020](https://jcgt.org/published/0009/04/01/paper.pdf)) —
bit-ops only, state of the art for convergence. STBN
([Wolfe et al.](https://arxiv.org/abs/2112.09629)) approximated by
golden-ratio-animating a 2D mask ([demofox](https://blog.demofox.org/2017/10/31/animating-noise-for-integration-over-time/)).

**RECOMMENDATION.** Path-tracer sampling: Owen-scrambled Sobol seeded per
pixel by PCG (upgrade path); *M0 ships per-pixel-per-frame PCG white noise* —
with N-count accumulation the converged image is identical, only the
transient differs at 64³ scale. Visible-noise shaping later: boot-time
void-and-cluster compute pass; IGN as the one-liner placeholder.

### 4.3 Procedural text without font files

Options surveyed: per-frame bezier SDF evaluation (IQ's [quadratic bezier SDF](https://www.shadertoy.com/view/MlKcDD);
too costly per pixel per glyph), msdfgen-as-wasm ([enso-org/msdfgen-wasm](https://github.com/enso-org/msdfgen-wasm);
heavy dependency, wants TTF input — a binary), and **code-authored stroke
typefaces**: the [Hershey fonts](https://en.wikipedia.org/wiki/Hershey_fonts)
(1967, public domain, pure polyline data available as source —
[techninja/hersheytextjs](https://github.com/techninja/hersheytextjs);
Roman Simplex ≈ 10–30 vertices/glyph, 95 glyphs ≈ a few KB of source).
Shadertoy practice: segment-SDF typefaces ([XsBSDm](https://www.shadertoy.com/view/XsBSDm)),
P_Malin's bitmap-digit `PrintValue` trick ([4sBSWW](https://www.shadertoy.com/view/4sBSWW), CC0).

**RECOMMENDATION.** Hershey-Simplex-style stroke data authored as TypeScript
source; boot compute pass bakes an SDF atlas via segment SDFs (stroke radius
= adjustable weight); render as quads with smoothstep AA. *M0's HUD uses the
system font stack in DOM (no font file shipped, constraint satisfied);
the in-world SDF typeface lands with the first dream that draws text into
the scene.*

### 4.4 Web Audio synthesis

All sample-free: OscillatorNode + gain envelopes (`setTargetAtTime`, never
instant steps); procedural `AudioBuffer` noise; ConvolverNode reverb with a
generated exponentially-decaying-noise IR ([reverbGen](https://github.com/adelespinasse/reverbGen),
[gskinner writeup](https://blog.gskinner.com/archives/2019/02/reverb-web-audio-api.html));
AudioWorklet for continuous ambience (ScriptProcessorNode is deprecated).
Parameter-tuple sound design to steal from: [ZzFX](https://github.com/KilledByAPixel/ZzFX) (MIT),
[jsfxr](https://github.com/chr15m/jsfxr).

**RECOMMENDATION.** Lazy AudioContext on first gesture; sfx bus → (later)
procedural-IR convolver → compressor; sounds as parameter tuples in source.
*M0 ships the minimal version: enveloped-oscillator cues in
`src/assets/audio.ts` (place / erase / bloom / completion chime).*
