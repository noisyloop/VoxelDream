import { describe, expect, it } from "vitest";
import { parseShaderDoc, ShaderDocError } from "../src/render/shaders/doc";

const GOOD = `//! # Brickmap DDA
//!
//! Two-level Amanatides–Woo traversal.
//!
//! ## Knobs
//! - \`maxBounces\` — path depth; 0 disables GI entirely.

fn main() {}
`;

describe("shader doc header parser", () => {
  it("extracts title and markdown from a //! header", () => {
    const parsed = parseShaderDoc(GOOD, "trace.wgsl");
    expect(parsed.doc.title).toBe("Brickmap DDA");
    expect(parsed.doc.markdown).toContain("Amanatides–Woo");
    expect(parsed.doc.markdown).toContain("`maxBounces`");
    expect(parsed.code).toBe(GOOD); // full source preserved, header included
  });

  it("rejects a shader with no doc header", () => {
    expect(() => parseShaderDoc("fn main() {}", "bare.wgsl")).toThrow(ShaderDocError);
  });

  it("rejects a header with no title line", () => {
    expect(() => parseShaderDoc("//! just prose\nfn main() {}", "x.wgsl")).toThrow(
      /no "# Title"/
    );
  });

  it("stops at the first non-header line", () => {
    const src = `//! # T\nfn main() {}\n//! not part of the header`;
    const parsed = parseShaderDoc(src, "x.wgsl");
    expect(parsed.doc.markdown).toBe("# T");
  });
});
