// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

const GESTURE_EVENTS = ["pointerdown", "keydown"] as const;

let ctx: AudioContext | null = null;
let armed = false;

function audioContextCtor(): typeof AudioContext | undefined {
  return (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

function disarm(): void {
  if (typeof document === "undefined") return;
  for (const event of GESTURE_EVENTS) document.removeEventListener(event, onGesture, true);
  armed = false;
}

function onGesture(): void {
  const c = ensureContext();
  if (!c) {
    disarm();
    return;
  }
  void c
    .resume()
    .then(() => {
      if (c.state === "running") disarm();
    })
    .catch(() => {});
}

/**
 * Install one-time gesture listeners that unlock the AudioContext under
 * browser autoplay policy. Call once at app start, before the operator's
 * first interaction; idempotent.
 */
export function armPaymentChime(): void {
  if (armed || typeof document === "undefined" || !audioContextCtor()) return;
  armed = true;
  for (const event of GESTURE_EVENTS) document.addEventListener(event, onGesture, true);
}

interface BellPartial {
  frequency: number;
  level: number;
}

const BELL_PARTIALS: BellPartial[] = [
  { frequency: 1318.51, level: 1 },
  { frequency: 2637.02, level: 0.35 },
];
const ATTACK_S = 0.012;
const DECAY_S = 0.6;
const PEAK_GAIN = 0.18;

/**
 * Play a short synthesized service-bell "ding". Silently no-ops when audio is
 * unavailable or still locked; a locked context is nudged with `resume()` so
 * the next chime can sound.
 */
export function playPaymentChime(): void {
  const c = ensureContext();
  if (!c) return;
  if (c.state !== "running") {
    // Scheduling on a suspended context would queue dings that all burst out
    // on unlock — drop this one instead.
    void c.resume().catch(() => {});
    armPaymentChime();
    return;
  }

  const t = c.currentTime;
  const envelope = c.createGain();
  envelope.gain.setValueAtTime(0.0001, t);
  envelope.gain.exponentialRampToValueAtTime(PEAK_GAIN, t + ATTACK_S);
  envelope.gain.exponentialRampToValueAtTime(0.0001, t + DECAY_S);
  envelope.connect(c.destination);

  for (const { frequency, level } of BELL_PARTIALS) {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = frequency;
    const partialGain = c.createGain();
    partialGain.gain.value = level;
    osc.connect(partialGain);
    partialGain.connect(envelope);
    osc.start(t);
    osc.stop(t + DECAY_S + 0.05);
  }
}
