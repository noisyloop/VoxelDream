// Golden-hash helper for the shader/procgen test harness.
//
// Per SPEC: golden tests store a hash of a deterministic, regenerable
// output — never the output itself (that would be a binary asset). FNV-1a
// 32-bit is enough to pin "did this deterministic generator change".

export function fnv1a(bytes: Uint8Array | number[]): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= (bytes as Uint8Array)[i]! & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function fnv1aString(s: string): string {
  return fnv1a(new TextEncoder().encode(s));
}
