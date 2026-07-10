// The Dreaming renderer: hand-written WebGPU around the two WGSL passes.
//
// Owns the GPU mirrors of the 64³ world (voxel/brick occupancy bitmasks,
// packed material bytes, the light list) and the accumulation policy:
//
//  - camera still   → alpha = 1/(N+1): exact running average, converges ~1 s
//  - camera moving  → internal resolution halves and alpha is floored, so
//                     the image stays responsive at >60 fps
//  - world edited   → N clamps to a small value instead of resetting, so a
//                     stamp of voxels reconverges in a fraction of a second
//                     without the frame collapsing back to noise
//
// Three.js is nowhere near this file, per SPEC constraint 3.

import traceShader from "../shaders/trace.wgsl";
import blitShader from "../shaders/blit.wgsl";
import { paletteToFloat32Array, type PaletteEntry } from "../../core/palette";
import type { World } from "../../core/world";
import type { OrbitCamera } from "../camera";

export const WORLD_SIZE = 64;
const BRICKS = WORLD_SIZE / 8; // 8 bricks per axis
const MAX_LIGHTS = 256;
const MOTION_SCALE = 0.5; // internal resolution factor while the camera moves
const MOVING_ALPHA_FLOOR = 0.25;
const EDIT_CLAMP_N = 10;

export interface FrameStats {
  /** Accumulated samples in the current image. */
  samples: number;
  moving: boolean;
}

export class DreamingRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private canvas: HTMLCanvasElement;

  private tracePipeline: GPUComputePipeline;
  private blitPipeline: GPURenderPipeline;

  private uniformBuf: GPUBuffer;
  private brickOccBuf: GPUBuffer;
  private voxOccBuf: GPUBuffer;
  private materialsBuf: GPUBuffer;
  private paletteBuf: GPUBuffer;
  private lightsBuf: GPUBuffer;
  private accumBuf: GPUBuffer | null = null;

  private traceBindGroup: GPUBindGroup | null = null;
  private blitBindGroup: GPUBindGroup | null = null;

  // CPU mirrors of the GPU world state.
  private voxOcc = new Uint32Array((WORLD_SIZE ** 3) / 32);
  private materials = new Uint32Array((WORLD_SIZE ** 3) / 4);
  private brickOcc = new Uint32Array((BRICKS ** 3) / 32);
  private brickCounts = new Uint16Array(BRICKS ** 3);
  private lights = new Map<number, number>(); // voxel index -> material
  private lightsDirty = true;
  private lightCount = 0;

  private palette: PaletteEntry[];

  // Accumulation state.
  private samples = 0;
  private frameIndex = 0;
  private lastCamVersion = -1;
  private lastMotionAt = 0;
  private wasMoving = false;
  private lastGi = true;
  private width = 0;
  private height = 0;

  static supported(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  static async create(canvas: HTMLCanvasElement, palette: PaletteEntry[]): Promise<DreamingRenderer> {
    if (!DreamingRenderer.supported()) {
      throw new Error("WebGPU is not available in this browser.");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter request failed.");
    const device = await adapter.requestDevice();
    return new DreamingRenderer(canvas, device, palette);
  }

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, palette: PaletteEntry[]) {
    this.canvas = canvas;
    this.device = device;
    this.palette = palette;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context = canvas.getContext("webgpu") as GPUCanvasContext;
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });

    const traceModule = device.createShaderModule({ code: traceShader.code, label: "trace" });
    const blitModule = device.createShaderModule({ code: blitShader.code, label: "blit" });

    this.tracePipeline = device.createComputePipeline({
      label: "trace",
      layout: "auto",
      compute: { module: traceModule, entryPoint: "main" },
    });
    this.blitPipeline = device.createRenderPipeline({
      label: "blit",
      layout: "auto",
      vertex: { module: blitModule, entryPoint: "vs" },
      fragment: { module: blitModule, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.uniformBuf = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.brickOccBuf = device.createBuffer({ size: this.brickOcc.byteLength, usage: storage });
    this.voxOccBuf = device.createBuffer({ size: this.voxOcc.byteLength, usage: storage });
    this.materialsBuf = device.createBuffer({ size: this.materials.byteLength, usage: storage });
    this.paletteBuf = device.createBuffer({ size: 256 * 16, usage: storage });
    this.lightsBuf = device.createBuffer({ size: MAX_LIGHTS * 16, usage: storage });

    device.queue.writeBuffer(this.paletteBuf, 0, paletteToFloat32Array(palette));
  }

  /** Rebuild all GPU mirrors from the world (initial upload). */
  uploadWorld(world: World): void {
    this.voxOcc.fill(0);
    this.materials.fill(0);
    this.brickOcc.fill(0);
    this.brickCounts.fill(0);
    this.lights.clear();
    world.forEach((x, y, z, mat) => this.mirrorSet(x, y, z, mat));
    const q = this.device.queue;
    q.writeBuffer(this.voxOccBuf, 0, this.voxOcc);
    q.writeBuffer(this.materialsBuf, 0, this.materials);
    q.writeBuffer(this.brickOccBuf, 0, this.brickOcc);
    this.lightsDirty = true;
    this.samples = 0;
  }

  /** Apply a single voxel edit; partial GPU writes, graceful invalidation. */
  applyEdit(x: number, y: number, z: number, mat: number): void {
    this.mirrorSet(x, y, z, mat);
    const i = x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE;
    const q = this.device.queue;
    q.writeBuffer(this.voxOccBuf, (i >> 5) * 4, this.voxOcc, i >> 5, 1);
    q.writeBuffer(this.materialsBuf, (i >> 2) * 4, this.materials, i >> 2, 1);
    const bi = (x >> 3) + (y >> 3) * BRICKS + (z >> 3) * BRICKS * BRICKS;
    q.writeBuffer(this.brickOccBuf, (bi >> 5) * 4, this.brickOcc, bi >> 5, 1);
    // Graceful invalidation: keep the accumulated image, but let new samples
    // dominate for a while. The stamp blooms in; the rest barely flickers.
    this.samples = Math.min(this.samples, EDIT_CLAMP_N);
  }

  private mirrorSet(x: number, y: number, z: number, mat: number): void {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE || z >= WORLD_SIZE) return;
    const i = x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE;
    const word = i >> 2;
    const shift = (i & 3) * 8;
    const prev = (this.materials[word]! >>> shift) & 0xff;
    if (prev === mat) return;
    this.materials[word] = (this.materials[word]! & ~(0xff << shift)) | (mat << shift);

    const wasSolid = prev !== 0;
    const isSolid = mat !== 0;
    if (wasSolid !== isSolid) {
      const bit = 1 << (i & 31);
      const bi = (x >> 3) + (y >> 3) * BRICKS + (z >> 3) * BRICKS * BRICKS;
      const bbit = 1 << (bi & 31);
      if (isSolid) {
        this.voxOcc[i >> 5]! |= bit;
        if (this.brickCounts[bi]! === 0) this.brickOcc[bi >> 5]! |= bbit;
        this.brickCounts[bi]!++;
      } else {
        this.voxOcc[i >> 5]! &= ~bit;
        this.brickCounts[bi]!--;
        if (this.brickCounts[bi]! === 0) this.brickOcc[bi >> 5]! &= ~bbit;
      }
    }

    const wasLight = wasSolid && (this.palette[prev]?.emissive ?? 0) > 0;
    const isLight = isSolid && (this.palette[mat]?.emissive ?? 0) > 0;
    if (wasLight) this.lights.delete(i);
    if (isLight) this.lights.set(i, mat);
    if (wasLight || isLight) this.lightsDirty = true;
  }

  private syncLights(): void {
    if (!this.lightsDirty) return;
    const data = new Float32Array(MAX_LIGHTS * 4);
    let n = 0;
    for (const [i, mat] of this.lights) {
      if (n >= MAX_LIGHTS) break;
      const x = i % WORLD_SIZE;
      const y = Math.floor(i / WORLD_SIZE) % WORLD_SIZE;
      const z = Math.floor(i / (WORLD_SIZE * WORLD_SIZE));
      data[n * 4 + 0] = x + 0.5;
      data[n * 4 + 1] = y + 0.5;
      data[n * 4 + 2] = z + 0.5;
      data[n * 4 + 3] = mat;
      n++;
    }
    this.lightCount = n;
    this.device.queue.writeBuffer(this.lightsBuf, 0, data);
    this.lightsDirty = false;
  }

  private ensureSize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(8, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(8, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height && this.accumBuf) return false;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.accumBuf?.destroy();
    this.accumBuf = this.device.createBuffer({
      size: w * h * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.traceBindGroup = this.device.createBindGroup({
      layout: this.tracePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: { buffer: this.brickOccBuf } },
        { binding: 2, resource: { buffer: this.voxOccBuf } },
        { binding: 3, resource: { buffer: this.materialsBuf } },
        { binding: 4, resource: { buffer: this.paletteBuf } },
        { binding: 5, resource: { buffer: this.lightsBuf } },
        { binding: 6, resource: { buffer: this.accumBuf } },
      ],
    });
    this.blitBindGroup = this.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: { buffer: this.accumBuf } },
      ],
    });
    this.samples = 0;
    return true;
  }

  frame(camera: OrbitCamera, giEnabled: boolean): FrameStats {
    this.ensureSize();
    this.syncLights();

    const now = performance.now();
    if (camera.version !== this.lastCamVersion) {
      this.lastCamVersion = camera.version;
      this.lastMotionAt = now;
      this.samples = 0;
    }
    const moving = now - this.lastMotionAt < 120;
    if (moving !== this.wasMoving) {
      this.wasMoving = moving;
      this.samples = 0; // internal resolution changes; history is stale
    }
    if (giEnabled !== this.lastGi) {
      this.lastGi = giEnabled;
      this.samples = 0; // the lighting model itself changed
    }

    const scale = moving ? MOTION_SCALE : 1.0;
    const rw = Math.max(8, Math.floor(this.width * scale));
    const rh = Math.max(8, Math.floor(this.height * scale));

    let alpha = 1 / (this.samples + 1);
    if (moving) alpha = Math.max(alpha, MOVING_ALPHA_FLOOR);

    // Uniforms — layout must match the struct in trace.wgsl / blit.wgsl.
    const f = new Float32Array(24);
    const u = new Uint32Array(f.buffer);
    const pos = camera.position;
    const { right, up, forward } = camera.basis;
    f.set(pos, 0);
    u[3] = this.frameIndex;
    f.set(right, 4);
    f[7] = alpha;
    f.set(up, 8);
    u[11] = this.lightCount;
    f.set(forward, 12);
    u[15] = giEnabled ? 1 : 0;
    f[16] = rw;
    f[17] = rh;
    f[18] = Math.tan(camera.fov / 2);
    u[19] = moving ? 1 : 3; // maxBounces: one indirect bounce in motion, three still
    // Radiant power multiplier for NEE. A single emissive voxel is a tiny
    // 1/d^2 source in a 64-voxel-wide room; ~50 lands "one lantern lights
    // a chamber" (tonemap keeps the highlight in range).
    f[20] = 50.0; // lightScale
    f[21] = this.width;
    f[22] = this.height;
    this.device.queue.writeBuffer(this.uniformBuf, 0, f);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.tracePipeline);
    pass.setBindGroup(0, this.traceBindGroup!);
    pass.dispatchWorkgroups(Math.ceil(rw / 8), Math.ceil(rh / 8));
    pass.end();

    const view = this.context.getCurrentTexture().createView();
    const render = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
    });
    render.setPipeline(this.blitPipeline);
    render.setBindGroup(0, this.blitBindGroup!);
    render.draw(3);
    render.end();
    this.device.queue.submit([encoder.finish()]);

    this.frameIndex++;
    this.samples = Math.min(this.samples + 1, 4095);
    this.lastRW = rw;
    this.lastRH = rh;
    return { samples: this.samples, moving };
  }

  private lastRW = 0;
  private lastRH = 0;

  /**
   * Read the accumulation buffer back to the CPU and apply the same
   * tonemap as blit.wgsl. Exists for headless golden-image capture and
   * debugging — the render loop never calls it.
   */
  async capture(): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }> {
    const w = this.lastRW;
    const h = this.lastRH;
    if (!this.accumBuf || w === 0) throw new Error("nothing rendered yet");
    const staging = this.device.createBuffer({
      size: w * h * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.accumBuf, 0, staging, 0, w * h * 16);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const hdr = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    const aces = (x: number) =>
      Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
    const srgb = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) {
        pixels[i * 4 + c] = srgb(aces(hdr[i * 4 + c]! * 1.35)) * 255;
      }
      pixels[i * 4 + 3] = 255;
    }
    return { width: w, height: h, pixels };
  }
}
