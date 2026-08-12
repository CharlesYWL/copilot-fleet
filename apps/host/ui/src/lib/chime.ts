/**
 * Two short tones, synthesised rather than shipped as files.
 *
 * A fleet is watched out of the corner of an eye, so the point of these is to
 * be recognisable without being looked at: a rising pair when an agent finishes
 * and a lower, doubled one when it is blocked and cannot continue without a
 * human. Nothing here is loud enough to be worth reaching for the volume key.
 *
 * Generating them avoids binary assets in the bundle, which also means they
 * work on a Host that has never been online.
 */

export type ChimeKind = "done" | "permission";

type Tone = { hz: number; at: number; seconds: number };

/**
 * Recipes, in the order the notes are struck.
 *
 * "Done" rises, because a finished turn is a small good thing. "Permission"
 * repeats a lower note twice: an interruption should be distinguishable with
 * the ears alone, from another room, without counting pitches.
 */
const RECIPES: Record<ChimeKind, Tone[]> = {
  done: [
    { hz: 660, at: 0, seconds: 0.09 },
    { hz: 880, at: 0.085, seconds: 0.13 },
  ],
  permission: [
    { hz: 494, at: 0, seconds: 0.12 },
    { hz: 494, at: 0.19, seconds: 0.16 },
  ],
};

const PEAK_GAIN = 0.06;

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

let context: AudioContext | undefined;

/**
 * One context for the app, created on first use.
 *
 * Browsers refuse to start audio until the page has been interacted with, and a
 * context built at import time would be born suspended and stay that way. This
 * is called from an event handler the first time a chime is due, by which point
 * the operator has clicked something.
 */
function getContext(): AudioContext | undefined {
  const Ctor = audioContextConstructor();
  if (!Ctor) return undefined;
  context ??= new Ctor();
  // A context can be suspended again when a tab is backgrounded, which is
  // precisely when these sounds matter most.
  if (context.state === "suspended") void context.resume();
  return context;
}

export function playChime(kind: ChimeKind): void {
  const ctx = getContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const tone of RECIPES[kind]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    // A sine avoids the harmonics that make short square-wave beeps sound like
    // an error even when they are not.
    oscillator.type = "sine";
    oscillator.frequency.value = tone.hz;
    const start = now + tone.at;
    const end = start + tone.seconds;
    // Ramping both ends removes the click a bare start/stop puts on the speaker.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }
}
