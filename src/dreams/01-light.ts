// Dream 01: Light.
//
// The first lesson. The player is given a dark room and exactly one
// affordance: place a single emissive voxel. No text explains normals,
// bounce, or falloff — the GI pass is the explanation. Completing it
// unlocks the emissive brush in a bare sandbox and the shader exporter.

import { MAT } from "../core/palette";

export const dream01 = {
  id: "01-light",
  title: "Light",

  /** The one tool this dream grants. */
  brushMaterial: MAT.LIGHT_WARM,

  intro: "It is dark here.<br/>You are holding one <em>light</em>. Click to let it go.",

  /** Shown while the first light blooms; kept short so the room does the talking. */
  bloom: "",

  completion:
    "That glow on the far wall never touched your light.<br/>" +
    "It is the room answering — light bouncing off light.<br/><br/>" +
    "<em>The emissive brush is yours.</em> Build with it. Erase. Orbit.<br/>" +
    "When it feels right, take the room with you — export it as a shader.",

  /** How long the bloom moment holds before the sandbox unlocks (ms). */
  bloomHoldMs: 3200,
} as const;
