// Boot: build the world, start the Dreaming renderer, run Dream 01.

import traceShader from "./render/shaders/trace.wgsl";
import blitShader from "./render/shaders/blit.wgsl";
import { World } from "./core/world";
import { History } from "./core/history";
import { raycast } from "./core/raycast";
import { generateDefaultPalette } from "./core/palette";
import { generateRoom } from "./dreams/room";
import { dream01 } from "./dreams/01-light";
import { OrbitCamera } from "./render/camera";
import { DreamingRenderer } from "./render/dreaming/renderer";
import { place, erase } from "./brushes/emissive";
import { exportShader } from "./export/shader";
import { store } from "./ui/store";
import { initHud, setStats, showFatal, showMessage } from "./ui/hud";
import { playBloom, playChime, playErase, playPlace } from "./assets/audio";

async function boot(): Promise<void> {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;

  if (!DreamingRenderer.supported()) {
    showFatal(
      "<div><strong>VoxelDream needs WebGPU.</strong><br/>" +
        "The Dreaming renderer is a WGSL path tracer; there is no faithful WebGL2 version of it " +
        "(the meshed Waking mode will degrade to WebGL2 in a later milestone — SPEC constraint 2).<br/>" +
        'Chrome/Edge 113+, Safari 18+, or Firefox 141+ should work: <a href="https://caniuse.com/webgpu">caniuse.com/webgpu</a></div>'
    );
    return;
  }

  const world = new World();
  generateRoom(world);
  world.clearDirty();

  const palette = generateDefaultPalette();
  const history = new History();
  const camera = new OrbitCamera();

  let renderer: DreamingRenderer;
  try {
    renderer = await DreamingRenderer.create(canvas, palette);
  } catch (err) {
    showFatal(
      `<div><strong>WebGPU device request failed.</strong><br/>${String(err)}<br/>` +
        "Try a Chromium-based browser with hardware acceleration enabled.</div>"
    );
    return;
  }
  renderer.uploadWorld(world);

  // --- HUD -----------------------------------------------------------------
  initHud(
    [
      { filename: "trace.wgsl", doc: traceShader.doc, code: traceShader.code },
      { filename: "blit.wgsl", doc: blitShader.doc, code: blitShader.code },
    ],
    {
      onExport() {
        const { glsl, warnings } = exportShader(world, palette);
        for (const w of warnings) console.warn(`[export] ${w}`);
        const blob = new Blob([glsl], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "voxeldream-dream01.glsl";
        a.click();
        URL.revokeObjectURL(a.href);
        showMessage(
          "A shader left the dream.<br/>Paste it into a new <em>shadertoy.com</em> shader — it runs as-is."
        );
        window.setTimeout(() => showMessage(""), 9000);
      },
    }
  );

  showMessage(dream01.intro);

  // --- Dream 01 progression -------------------------------------------------
  function onFirstLightPlaced(): void {
    store.getState().setPhase("blooming");
    showMessage(dream01.bloom);
    playBloom();
    window.setTimeout(() => {
      store.getState().setPhase("sandbox");
      showMessage(dream01.completion);
      playChime();
      window.setTimeout(() => {
        if (store.getState().phase === "sandbox") showMessage("");
      }, 14000);
    }, dream01.bloomHoldMs);
  }

  // --- Input -----------------------------------------------------------------
  let dragging = false;
  let moved = 0;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved > 4) camera.orbit(-dx * 0.005, dy * 0.005);
  });

  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    if (moved > 4) return; // that was an orbit, not a click
    const s = store.getState();
    const ray = camera.ray(e.clientX, e.clientY, canvas.clientWidth, canvas.clientHeight);
    const hit = raycast(world, ...ray.origin, ...ray.dir, 512);
    if (!hit) return;

    if (s.phase === "first-light" || (s.phase === "sandbox" && s.tool === "place")) {
      const result = place(world, history, hit, s.lightMaterial);
      if (result) {
        renderer.applyEdit(result.x, result.y, result.z, result.mat);
        playPlace();
        s.recordLightPlaced();
        if (s.phase === "first-light") onFirstLightPlaced();
      }
    } else if (s.phase === "sandbox" && s.tool === "erase") {
      const result = erase(world, history, hit);
      renderer.applyEdit(result.x, result.y, result.z, 0);
      playErase();
    }
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.dolly(Math.exp(e.deltaY * 0.0012));
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    const s = store.getState();
    if (e.key === "Escape" && s.codePanelOpen) s.toggleCodePanel();
    if (s.phase !== "sandbox") return;
    if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const ok = e.shiftKey ? history.redo(world) : history.undo(world);
      if (ok) renderer.uploadWorld(world); // batch-sized change; full re-mirror is cheap
    }
  });

  // --- Frame loop --------------------------------------------------------------
  let fps = 60;
  let lastT = performance.now();
  function loop(): void {
    const now = performance.now();
    fps = fps * 0.95 + (1000 / Math.max(now - lastT, 0.1)) * 0.05;
    lastT = now;
    const stats = renderer.frame(camera, store.getState().giEnabled);
    setStats(`${fps.toFixed(0)} fps · ${stats.samples} spp${stats.moving ? " · moving" : ""}`);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

void boot();
