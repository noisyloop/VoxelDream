// All sound is synthesized — a Web Audio graph per cue, no samples ever
// (SPEC constraint 1). Each cue is a tiny worked example of subtractive
// synthesis: oscillator → filter → gain envelope → master.
//
// The AudioContext is created lazily on the first user gesture because
// browsers refuse to start audio before one.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureContext(): { ctx: AudioContext; master: GainNode } | null {
  if (typeof AudioContext === "undefined") return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return { ctx, master: master! };
}

/** One enveloped oscillator blip. */
function blip(
  freq: number,
  opts: { type?: OscillatorType; attack?: number; decay?: number; gain?: number; glideTo?: number } = {}
): void {
  const audio = ensureContext();
  if (!audio) return;
  const { type = "triangle", attack = 0.004, decay = 0.18, gain = 1, glideTo } = opts;
  const t = audio.ctx.currentTime;

  const osc = audio.ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(glideTo, t + decay);

  const env = audio.ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + attack);
  env.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);

  osc.connect(env).connect(audio.master);
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

/** Placing a voxel: a soft, slightly detuned pluck. */
export function playPlace(): void {
  blip(523.25, { gain: 0.5, decay: 0.14 });
  blip(527, { type: "sine", gain: 0.25, decay: 0.2 });
}

/** Erasing: a short downward swoop. */
export function playErase(): void {
  blip(320, { type: "sine", gain: 0.4, decay: 0.16, glideTo: 140 });
}

/** Dream complete: a slow major-ish arpeggio with a sine shimmer. */
export function playChime(): void {
  const notes = [392, 523.25, 659.25, 783.99]; // G4 C5 E5 G5
  notes.forEach((f, i) => {
    setTimeout(() => {
      blip(f, { type: "sine", gain: 0.45, attack: 0.01, decay: 0.9 });
      blip(f * 2, { type: "sine", gain: 0.12, attack: 0.02, decay: 1.2 });
    }, i * 170);
  });
}

/** First light placed: a low warm swell under the chime. */
export function playBloom(): void {
  blip(98, { type: "sine", gain: 0.5, attack: 0.15, decay: 1.6 });
  blip(196.5, { type: "triangle", gain: 0.2, attack: 0.2, decay: 1.4 });
}
