#!/usr/bin/env node
// Enforces the project's first absolute constraint: zero binary assets, ever.
//
// Two independent checks over every file tracked by git:
//   1. Extension allowlist — a file whose extension is not listed here fails
//      the build even if its contents happen to be text. New file types must
//      be added deliberately, in a reviewed commit.
//   2. Content sniff — a NUL byte in the first 8 KiB fails the build even if
//      the extension looks innocent (catches a PNG renamed to .ts).
import { execSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".mjs",
  ".wgsl",
  ".glsl",
  ".md",
  ".json",
  ".html",
  ".css",
  ".yml",
  ".yaml",
]);

// Extensionless tracked files that are known text.
const ALLOWED_BASENAMES = new Set(["LICENSE", ".gitignore", ".gitattributes"]);

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const failures = [];

for (const file of files) {
  const basename = file.split("/").at(-1);
  const dot = basename.lastIndexOf(".");
  const ext = dot > 0 ? basename.slice(dot).toLowerCase() : "";

  if (!ALLOWED_EXTENSIONS.has(ext) && !ALLOWED_BASENAMES.has(basename)) {
    failures.push(`${file}: extension "${ext || "(none)"}" is not in the allowlist`);
    continue;
  }

  const buf = Buffer.alloc(8192);
  let bytesRead = 0;
  try {
    const fd = openSync(file, "r");
    bytesRead = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
  } catch {
    continue; // deleted in working tree but still tracked — git will sort it out
  }
  if (buf.subarray(0, bytesRead).includes(0)) {
    failures.push(`${file}: contains NUL bytes (binary content)`);
  }
}

if (failures.length > 0) {
  console.error("Binary asset check FAILED. This repo ships zero binary assets, ever.\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nWrite the generator instead. If this is a genuinely new text format, add its extension to scripts/check-no-binaries.mjs in its own commit."
  );
  process.exit(1);
}

console.log(`Binary asset check passed (${files.length} tracked files, all text).`);
