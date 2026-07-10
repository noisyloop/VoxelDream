// The HUD: plain DOM, subscribed to the Zustand store. No component
// library (SPEC architecture). Everything visual here is text, CSS, or
// inline SVG from src/assets/icons.ts.

import { ICONS } from "../assets/icons";
import { LIGHT_COUNT, MAT, generateDefaultPalette } from "../core/palette";
import type { ShaderDoc } from "../render/shaders/doc";
import { store } from "./store";

export interface ShaderDocEntry {
  filename: string;
  doc: ShaderDoc;
  code: string;
}

export interface HudCallbacks {
  onExport(): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function showMessage(html: string): void {
  const el = $("#message".slice(1));
  el.innerHTML = html;
  el.classList.toggle("visible", html !== "");
}

export function showFatal(html: string): void {
  const el = $("fatal");
  el.innerHTML = html;
  el.classList.add("visible");
}

/**
 * A deliberately tiny markdown renderer — headings, lists, inline code,
 * paragraphs. It only needs to render our own shader doc headers.
 */
export function renderMarkdown(md: string): string {
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

  const out: string[] = [];
  let list = false;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (list && !line.startsWith("- ")) {
      out.push("</ul>");
      list = false;
    }
    if (line.startsWith("## ")) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith("# ")) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith("- ")) {
      if (!list) {
        out.push("<ul>");
        list = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line === "") out.push("");
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}

export function initHud(shaderDocs: ShaderDocEntry[], callbacks: HudCallbacks): void {
  const palette = generateDefaultPalette();
  const toolbar = $("toolbar");
  const corner = $("corner");
  const panel = $("codepanel");

  // --- Toolbar (hidden until the sandbox unlocks) ------------------------
  const toolButton = (id: string, icon: string, label: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = "tool";
    b.id = id;
    b.innerHTML = `${icon}<span>${label}</span>`;
    b.addEventListener("click", onClick);
    return b;
  };

  const placeBtn = toolButton("tool-place", ICONS.light, "place light", () =>
    store.getState().setTool("place")
  );
  const eraseBtn = toolButton("tool-erase", ICONS.erase, "erase", () =>
    store.getState().setTool("erase")
  );

  // Light hue swatches — the sandbox's one indulgence.
  const swatches = document.createElement("div");
  swatches.style.cssText = "display:flex;gap:4px;align-items:center;padding:0 6px;";
  for (let i = 0; i < LIGHT_COUNT; i++) {
    const mat = MAT.LIGHT_WARM + i;
    const e = palette[mat]!;
    const s = document.createElement("button");
    s.dataset.mat = String(mat);
    const css = `rgb(${lin(e.r)},${lin(e.g)},${lin(e.b)})`;
    s.style.cssText = `width:18px;height:18px;border-radius:5px;cursor:pointer;background:${css};border:2px solid transparent;`;
    s.title = "light hue";
    s.addEventListener("click", () => store.getState().setLightMaterial(mat));
    swatches.appendChild(s);
  }

  const exportBtn = toolButton("tool-export", ICONS.download, "export as shader", callbacks.onExport);
  exportBtn.classList.add("primary");

  toolbar.append(placeBtn, eraseBtn, swatches, exportBtn);

  // --- Corner: debug + code panel toggle + stats -------------------------
  const giLabel = document.createElement("label");
  const giBox = document.createElement("input");
  giBox.type = "checkbox";
  giBox.checked = store.getState().giEnabled;
  giBox.addEventListener("change", () => store.getState().toggleGi());
  giLabel.append(giBox, document.createTextNode("bounce light (GI)"));

  const codeBtn = document.createElement("button");
  codeBtn.innerHTML = "show me the code";
  codeBtn.addEventListener("click", () => store.getState().toggleCodePanel());

  const stats = document.createElement("span");
  stats.id = "stats";

  corner.append(giLabel, codeBtn, stats);

  // --- "Show me the code" panel ------------------------------------------
  // Renders the doc headers parsed AT BUILD TIME from the real .wgsl files
  // (see wgslDocPlugin in vite.config.ts) — not hardcoded strings.
  panel.innerHTML = `
    <header><h2>show me the code</h2><button id="code-close">✕</button></header>
    <nav id="codetabs"></nav>
    <div id="codebody"></div>`;
  panel.querySelector("#code-close")!.addEventListener("click", () =>
    store.getState().toggleCodePanel()
  );
  const tabs = panel.querySelector("#codetabs")!;
  const body = panel.querySelector("#codebody")!;
  let activeTab = 0;

  const renderPanel = () => {
    tabs.innerHTML = "";
    shaderDocs.forEach((entry, i) => {
      const t = document.createElement("button");
      t.textContent = entry.filename;
      t.classList.toggle("active", i === activeTab);
      t.addEventListener("click", () => {
        activeTab = i;
        renderPanel();
      });
      tabs.appendChild(t);
    });
    const entry = shaderDocs[activeTab];
    if (entry) {
      body.innerHTML =
        `<div class="doc">${renderMarkdown(entry.doc.markdown)}</div>` +
        `<pre>${entry.code.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`;
    }
  };
  renderPanel();

  // --- Store subscription --------------------------------------------------
  const sync = () => {
    const s = store.getState();
    toolbar.classList.toggle("visible", s.phase === "sandbox");
    panel.classList.toggle("visible", s.codePanelOpen);
    placeBtn.classList.toggle("active", s.tool === "place");
    eraseBtn.classList.toggle("active", s.tool === "erase");
    giBox.checked = s.giEnabled;
    for (const el of swatches.children) {
      const sw = el as HTMLButtonElement;
      sw.style.borderColor = Number(sw.dataset.mat) === s.lightMaterial ? "#fff" : "transparent";
    }
  };
  store.subscribe(sync);
  sync();
}

export function setStats(text: string): void {
  const el = document.getElementById("stats");
  if (el) el.textContent = text;
}

/** Linear-space palette value back to display sRGB 0-255 for CSS. */
function lin(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}
