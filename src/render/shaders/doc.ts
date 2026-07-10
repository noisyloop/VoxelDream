// Parser for WGSL/GLSL doc headers.
//
// Constraint 5 of SPEC.md: every shader ships with its own explanation, and
// that explanation is a build-time dependency — the Vite plugin in
// vite.config.ts runs this parser on every imported .wgsl file and the
// "show me the code" panel renders the result. A shader without a doc
// header fails the import.
//
// Header format — a run of `//!` lines at the top of the file:
//
//   //! # Title of the technique
//   //!
//   //! Prose. Markdown-ish: headings, `code`, *emphasis*, lists.
//   //!
//   //! ## Knobs
//   //! - `uniformName` — what it means, and what happens if you change it.

export interface ShaderDoc {
  /** First `#` heading in the header. */
  title: string;
  /** Full header body as markdown (including the title line). */
  markdown: string;
}

export interface ParsedShader {
  doc: ShaderDoc;
  /** Shader source with the doc header still in place — the panel shows real source. */
  code: string;
}

export class ShaderDocError extends Error {}

export function parseShaderDoc(source: string, filename = "<shader>"): ParsedShader {
  const lines = source.split("\n");
  const docLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//!")) {
      // Strip the marker and at most one following space.
      docLines.push(trimmed.slice(3).replace(/^ /, ""));
    } else if (docLines.length === 0 && trimmed === "") {
      continue; // allow leading blank lines
    } else {
      break; // header is a contiguous block at the top
    }
  }

  if (docLines.length === 0) {
    throw new ShaderDocError(
      `${filename}: missing doc header. Every shader in this repo starts with a "//!" comment block ` +
        `explaining the technique, its reference, and its knobs (SPEC.md, constraint 5).`
    );
  }

  const markdown = docLines.join("\n").trim();
  const titleLine = docLines.find((l) => l.startsWith("# "));
  if (!titleLine) {
    throw new ShaderDocError(
      `${filename}: doc header has no "# Title" line. Name the technique.`
    );
  }

  return { doc: { title: titleLine.slice(2).trim(), markdown }, code: source };
}
