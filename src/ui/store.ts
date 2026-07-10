// App state: Zustand vanilla store (no React, no component library —
// the UI is plain DOM that subscribes to this).

import { createStore } from "zustand/vanilla";

export type Phase =
  /** Dream 01 opening: dark room, exactly one action available. */
  | "first-light"
  /** The moment after the first light lands; UI holds its breath. */
  | "blooming"
  /** Dream 01 complete: emissive brush unlocked, export available. */
  | "sandbox";

export type Tool = "place" | "erase";

export interface AppState {
  phase: Phase;
  tool: Tool;
  /** Palette index the place tool stamps (an emissive material). */
  lightMaterial: number;
  /** Debug flag: turn off the indirect bounce to see what GI buys. */
  giEnabled: boolean;
  codePanelOpen: boolean;
  lightsPlaced: number;

  setPhase(phase: Phase): void;
  setTool(tool: Tool): void;
  setLightMaterial(mat: number): void;
  toggleGi(): void;
  toggleCodePanel(): void;
  recordLightPlaced(): void;
}

export const store = createStore<AppState>((set) => ({
  phase: "first-light",
  tool: "place",
  lightMaterial: 16, // MAT.LIGHT_WARM
  giEnabled: true,
  codePanelOpen: false,
  lightsPlaced: 0,

  setPhase: (phase) => set({ phase }),
  setTool: (tool) => set({ tool }),
  setLightMaterial: (lightMaterial) => set({ lightMaterial }),
  toggleGi: () => set((s) => ({ giEnabled: !s.giEnabled })),
  toggleCodePanel: () => set((s) => ({ codePanelOpen: !s.codePanelOpen })),
  recordLightPlaced: () => set((s) => ({ lightsPlaced: s.lightsPlaced + 1 })),
}));
