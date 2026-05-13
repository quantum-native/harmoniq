import type { ChannelDirection } from "./quantum.js";
import type { ChannelAudioConfig, EnvelopeParams } from "./audio.js";

/**
 * A user-defined sampling channel. Combines a Bloch direction (basis), sound
 * settings, and UI state (name, color). Each channel projects the n-qubit
 * state along its Bloch vector before sampling, and drives its own oscillator
 * bank with the resulting probabilities.
 */
export interface Channel {
  id: string;
  name: string;
  color: string;
  // Basis (Bloch vector)
  /** Polar angle from +z. 0 → +z (Z basis), π/2 → equator, π → −z. */
  theta: number;
  /** Azimuth around z. 0 → +x (X basis), π/2 → +y, π → −x. */
  phi: number;
  /** When true, rotation in the HUD snaps to multiples of π/8. */
  snap: boolean;
  // Sound
  waveform: OscillatorType;
  octaveOffset: number;
  /**
   * 0–1. 0 = hold (no decay); >0 = decay-to-near-zero over
   * `0.05 + (1 - decay) * 2.0` seconds. Same shape as the v0.3 global slider.
   */
  decay: number;
  volume: number;
  muted: boolean;
}

export const MAX_CHANNELS = 4;

const COLOR_PALETTE = [
  "#22d3ee", // cyan
  "#fbbf24", // gold
  "#f472b6", // pink
  "#a855f7", // violet
] as const;

/** Map a Channel's flat `decay` slider value to the audio engine's ADSR envelope. */
export function envelopeFromDecay(decay: number): EnvelopeParams {
  if (decay <= 0) return { attack: 0.015, decay: 0.001, sustain: 1, release: 0 };
  return {
    attack: 0.015,
    decay: 0.05 + (1 - decay) * 2.0,
    sustain: 0.0001,
    release: 0,
  };
}

/** Project a Channel into the shape the quantum engine consumes. */
export function toDirection(c: Channel): ChannelDirection {
  return { id: c.id, theta: c.theta, phi: c.phi };
}

/** Project a Channel into the shape the audio engine consumes. */
export function toAudioConfig(c: Channel): ChannelAudioConfig {
  return {
    id: c.id,
    waveform: c.waveform,
    octaveOffset: c.octaveOffset,
    volume: c.volume,
    envelope: envelopeFromDecay(c.decay),
    muted: c.muted,
  };
}

export interface ChannelsStore {
  list(): readonly Channel[];
  get(id: string): Channel | undefined;
  /** Append a new channel. Returns null when at MAX_CHANNELS. */
  add(seed?: Partial<Channel>): Channel | null;
  remove(id: string): void;
  /** Patch a single channel by id. Patches are merged shallowly. */
  update(id: string, patch: Partial<Channel>): void;
  /**
   * Subscribe to structural changes (add/remove). Field updates do NOT fire
   * this — callers wire those directly from the input that changed them so
   * card DOM doesn't churn while the user is editing.
   */
  subscribeStructure(fn: () => void): () => void;
  /** Subscribe to any change (structure or field). Used for downstream re-evaluation. */
  subscribeAny(fn: () => void): () => void;
}

export function createChannelsStore(initial: Channel[]): ChannelsStore {
  let channels: Channel[] = [...initial];
  const structureListeners = new Set<() => void>();
  const anyListeners = new Set<() => void>();
  let idCounter = 1;

  function notifyStructure(): void {
    for (const fn of structureListeners) fn();
    for (const fn of anyListeners) fn();
  }
  function notifyAny(): void {
    for (const fn of anyListeners) fn();
  }

  function pickColor(): string {
    const taken = new Set(channels.map((c) => c.color));
    for (const c of COLOR_PALETTE) if (!taken.has(c)) return c;
    return COLOR_PALETTE[0]!;
  }

  function newId(): string {
    // Loop until an unused id appears (cheap given MAX_CHANNELS is small)
    for (;;) {
      const id = `ch${idCounter++}`;
      if (!channels.some((c) => c.id === id)) return id;
    }
  }

  return {
    list() { return channels; },
    get(id) { return channels.find((c) => c.id === id); },
    add(seed = {}) {
      if (channels.length >= MAX_CHANNELS) return null;
      const id = seed.id ?? newId();
      const channel: Channel = {
        id,
        name: seed.name ?? `Channel ${channels.length + 1}`,
        color: seed.color ?? pickColor(),
        theta: seed.theta ?? 0,
        phi: seed.phi ?? 0,
        snap: seed.snap ?? false,
        waveform: seed.waveform ?? "sine",
        octaveOffset: seed.octaveOffset ?? 0,
        decay: seed.decay ?? 0.5,
        volume: seed.volume ?? 0.6,
        muted: seed.muted ?? false,
      };
      channels = [...channels, channel];
      notifyStructure();
      return channel;
    },
    remove(id) {
      const next = channels.filter((c) => c.id !== id);
      if (next.length === channels.length) return;
      channels = next;
      notifyStructure();
    },
    update(id, patch) {
      let changed = false;
      channels = channels.map((c) => {
        if (c.id !== id) return c;
        changed = true;
        return { ...c, ...patch };
      });
      if (changed) notifyAny();
    },
    subscribeStructure(fn) { structureListeners.add(fn); return () => { structureListeners.delete(fn); }; },
    subscribeAny(fn) { anyListeners.add(fn); return () => { anyListeners.delete(fn); }; },
  };
}

/** Default bootstrap channels: Z (computational basis) + X (Hadamard basis). */
export function defaultChannels(): Channel[] {
  return [
    {
      id: "z",
      name: "Z",
      color: COLOR_PALETTE[0]!,
      theta: 0,
      phi: 0,
      snap: false,
      waveform: "sine",
      octaveOffset: 0,
      decay: 0.1,
      volume: 0.8,
      muted: false,
    },
    {
      id: "x",
      name: "X",
      color: COLOR_PALETTE[1]!,
      theta: Math.PI / 2,
      phi: 0,
      snap: false,
      waveform: "triangle",
      octaveOffset: 1,
      decay: 0.1,
      volume: 0.5,
      muted: false,
    },
  ];
}
