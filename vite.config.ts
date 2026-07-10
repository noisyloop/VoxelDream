/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { parseShaderDoc } from "./src/render/shaders/doc";

// Build-time WGSL importer (SPEC.md constraint 5).
//
// `import shader from "./x.wgsl"` yields `{ code, doc }` where `doc` is the
// parsed header. Parsing happens here, at build time — a shader with a
// missing or malformed doc header is a build error, not a runtime surprise.
function wgslDocPlugin(): Plugin {
  return {
    name: "voxeldream:wgsl-doc",
    transform(_code, id) {
      if (!id.endsWith(".wgsl")) return null;
      const source = readFileSync(id, "utf8");
      const parsed = parseShaderDoc(source, id);
      return {
        code:
          `export const code = ${JSON.stringify(parsed.code)};\n` +
          `export const doc = ${JSON.stringify(parsed.doc)};\n` +
          `export default { code, doc };\n`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [wgslDocPlugin()],
  // Shaders are imported as source and transformed above; keep Vite from
  // treating them as static assets.
  assetsInclude: [],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
