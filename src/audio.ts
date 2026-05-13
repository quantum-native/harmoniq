// Scale definitions: semitone offsets from root, repeating into higher octaves
const SCALE_PATTERNS = {
  "C major":    [0, 2, 4, 5, 7, 9, 11],
  "C minor":    [0, 2, 3, 5, 7, 8, 10],
  "pentatonic": [0, 2, 4, 7, 9],
  "whole tone": [0, 2, 4, 6, 8, 10],
  "chromatic":  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  "blues":      [0, 3, 5, 6, 7, 10],
  "dorian":     [0, 2, 3, 5, 7, 9, 10],
  "phrygian":   [0, 1, 3, 5, 7, 8, 10],
} as const satisfies Record<string, readonly number[]>;

export type ScaleName = keyof typeof SCALE_PATTERNS;

const SCALE_NAMES: ScaleName[] = Object.keys(SCALE_PATTERNS) as ScaleName[];

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Generate `count` frequencies by extending the scale pattern across octaves. */
function getFreqs(scaleName: string, rootOctave: number, count: number): number[] {
  const pattern: readonly number[] =
    (SCALE_PATTERNS as Record<string, readonly number[]>)[scaleName] ?? SCALE_PATTERNS["C major"];
  const rootMidi = 60 + (rootOctave - 4) * 12;
  const freqs: number[] = [];
  for (let i = 0; i < count; i++) {
    const octaveOffset = Math.floor(i / pattern.length) * 12;
    const noteOffset = pattern[i % pattern.length]!;
    freqs.push(midiToFreq(rootMidi + octaveOffset + noteOffset));
  }
  return freqs;
}

export { SCALE_NAMES };

/** Generate note names for `count` notes. */
export function getNoteNames(scaleName: string, rootOctave: number, count: number): string[] {
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const pattern: readonly number[] =
    (SCALE_PATTERNS as Record<string, readonly number[]>)[scaleName] ?? SCALE_PATTERNS["C major"];
  const rootMidi = 60 + (rootOctave - 4) * 12;
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const octaveOffset = Math.floor(i / pattern.length) * 12;
    const noteOffset = pattern[i % pattern.length]!;
    const midi = rootMidi + octaveOffset + noteOffset;
    result.push(names[midi % 12]! + Math.floor(midi / 12 - 1));
  }
  return result;
}

/** Generate basis state labels for n qubits. */
export function getBasisLabels(n: number): string[] {
  const count = 1 << n;
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    labels.push("|" + i.toString(2).padStart(n, "0") + ">");
  }
  return labels;
}

/** Generate ket labels for n qubits (using ⟩). */
export function getKets(n: number): string[] {
  const count = 1 << n;
  const kets: string[] = [];
  for (let i = 0; i < count; i++) {
    kets.push("|" + i.toString(2).padStart(n, "0") + "⟩");
  }
  return kets;
}

export interface EnvelopeParams {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** Per-channel audio settings. Each channel owns its own oscillator bank. */
export interface ChannelAudioConfig {
  id: string;
  waveform: OscillatorType;
  /** Pitch offset from the global root octave, in octaves. */
  octaveOffset: number;
  volume: number;
  envelope: EnvelopeParams;
  muted: boolean;
}

export interface AudioParams {
  scale: string;
  rootOctave: number;
  numQubits: number;
  reverb: number;
  masterVolume: number;
  channels: ChannelAudioConfig[];
}

export interface AudioAnalysers {
  channels: Map<string, AnalyserNode>;
  master: AnalyserNode | null;
}

export interface AudioEngine {
  start(): void;
  stop(): void;
  /** Drive each channel's gains from per-channel probability arrays, keyed by id. */
  updateProbabilities(perChannel: Record<string, ArrayLike<number>>): void;
  getAnalysers(): AudioAnalysers;
  setParams(newParams: Partial<AudioParams>): void;
  getParams(): AudioParams;
}

interface ChannelBus {
  config: ChannelAudioConfig;
  oscillators: OscillatorNode[];
  gains: GainNode[];
  bus: GainNode;
  analyser: AnalyserNode;
}

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let masterAnalyser: AnalyserNode | null = null;

  let reverbSend: GainNode | null = null;
  let delayNode: DelayNode | null = null;
  let feedbackGain: GainNode | null = null;
  let reverbFilter: BiquadFilterNode | null = null;

  const buses = new Map<string, ChannelBus>();
  let running = false;

  let params: AudioParams = {
    scale: "C major",
    rootOctave: 4,
    numQubits: 3,
    reverb: 0.2,
    masterVolume: 0.5,
    channels: [],
  };

  function ensureContext(): void {
    if (ctx) return;
    ctx = new AudioContext();

    masterGain = ctx.createGain();
    masterGain.gain.value = params.masterVolume;

    masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 2048;

    reverbSend = ctx.createGain();
    reverbSend.gain.value = params.reverb;
    delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.3;
    feedbackGain = ctx.createGain();
    feedbackGain.gain.value = 0.4;
    reverbFilter = ctx.createBiquadFilter();
    reverbFilter.type = "lowpass";
    reverbFilter.frequency.value = 2500;

    masterGain.connect(reverbSend);
    reverbSend.connect(delayNode);
    delayNode.connect(reverbFilter);
    reverbFilter.connect(feedbackGain);
    feedbackGain.connect(delayNode);
    feedbackGain.connect(masterAnalyser);

    masterGain.connect(masterAnalyser);
    masterAnalyser.connect(ctx.destination);

    // Build buses for any channels declared before the context existed
    for (const cfg of params.channels) createBus(cfg);
  }

  function createBus(config: ChannelAudioConfig): ChannelBus {
    if (!ctx || !masterGain) throw new Error("audio: context not initialized");
    const bus = ctx.createGain();
    bus.gain.value = config.muted ? 0 : config.volume;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    bus.connect(analyser);
    bus.connect(masterGain);

    const channelBus: ChannelBus = {
      config,
      oscillators: [],
      gains: [],
      bus,
      analyser,
    };
    buildChannelOscillators(channelBus);
    buses.set(config.id, channelBus);
    return channelBus;
  }

  function buildChannelOscillators(channelBus: ChannelBus): void {
    if (!ctx) return;
    // Fade out old oscillators before stopping to avoid pops
    if (channelBus.oscillators.length > 0) {
      const t = ctx.currentTime;
      const oldGains = channelBus.gains;
      const oldOsc = channelBus.oscillators;
      for (const g of oldGains) {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.02);
      }
      setTimeout(() => {
        oldOsc.forEach((o) => { try { o.stop(); } catch(e) {} });
      }, 50);
    }

    const count = 1 << params.numQubits;
    const freqs = getFreqs(
      params.scale,
      params.rootOctave + channelBus.config.octaveOffset,
      count,
    );

    const oscillators: OscillatorNode[] = [];
    const gains: GainNode[] = [];

    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = channelBus.config.waveform;
      osc.frequency.value = freqs[i]!;
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(channelBus.bus);
      osc.start();
      oscillators.push(osc);
      gains.push(gain);
    }
    channelBus.oscillators = oscillators;
    channelBus.gains = gains;
  }

  function destroyBus(id: string): void {
    const channelBus = buses.get(id);
    if (!channelBus || !ctx) {
      buses.delete(id);
      return;
    }
    const t = ctx.currentTime;
    for (const g of channelBus.gains) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.02);
    }
    const oldOsc = channelBus.oscillators;
    const bus = channelBus.bus;
    const analyser = channelBus.analyser;
    setTimeout(() => {
      oldOsc.forEach((o) => { try { o.stop(); } catch(e) {} });
      try { bus.disconnect(); } catch(e) {}
      try { analyser.disconnect(); } catch(e) {}
    }, 50);
    buses.delete(id);
  }

  function reconcileChannels(
    newChannels: ChannelAudioConfig[],
    globalRebuild: boolean,
  ): void {
    if (!ctx) return; // ensureContext will pick these up later
    const newIds = new Set(newChannels.map((c) => c.id));

    // Remove channels that are no longer present
    for (const id of [...buses.keys()]) {
      if (!newIds.has(id)) destroyBus(id);
    }

    // Add or update channels
    for (const cfg of newChannels) {
      const existing = buses.get(cfg.id);
      if (!existing) {
        createBus(cfg);
        continue;
      }
      const oscRebuild =
        globalRebuild ||
        existing.config.waveform !== cfg.waveform ||
        existing.config.octaveOffset !== cfg.octaveOffset;

      existing.config = cfg;
      existing.bus.gain.value = cfg.muted ? 0 : cfg.volume;

      if (oscRebuild) buildChannelOscillators(existing);
    }
  }

  function setParams(newParams: Partial<AudioParams>): void {
    const prev = params;
    const next: AudioParams = { ...prev, ...newParams };

    const globalRebuild =
      next.scale !== prev.scale ||
      next.rootOctave !== prev.rootOctave ||
      next.numQubits !== prev.numQubits;

    params = next;

    if (ctx) {
      if (masterGain) masterGain.gain.value = params.masterVolume;
      if (reverbSend) reverbSend.gain.value = params.reverb;
    }

    reconcileChannels(params.channels, globalRebuild);
  }

  function start(): void {
    ensureContext();
    if (ctx!.state === "suspended") ctx!.resume();
    running = true;
  }

  function stop(): void {
    running = false;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const bus of buses.values()) {
      for (const g of bus.gains) releaseGain(g.gain, bus.config.envelope.release, t);
    }
  }

  function releaseGain(gain: AudioParam, releaseTime: number, startTime: number): void {
    const fadeTime = Math.max(0.01, releaseTime);
    gain.cancelScheduledValues(startTime);
    gain.setValueAtTime(gain.value, startTime);
    gain.linearRampToValueAtTime(0, startTime + fadeTime);
  }

  function applyEnvelope(gain: AudioParam, target: number, envelope: EnvelopeParams, startTime: number): void {
    gain.cancelScheduledValues(startTime);
    gain.setValueAtTime(gain.value, startTime);

    if (target <= 0.0001) {
      releaseGain(gain, envelope.release, startTime);
      return;
    }

    const attackTime = Math.max(0.001, envelope.attack);
    const decayTime = Math.max(0, envelope.decay);
    const releaseTime = Math.max(0, envelope.release);
    const sustainTarget = Math.max(target * envelope.sustain, 0.0001);
    const peakTime = startTime + attackTime;
    const sustainTime = peakTime + decayTime;

    gain.linearRampToValueAtTime(target, peakTime);
    gain.linearRampToValueAtTime(sustainTarget, sustainTime);

    if (releaseTime > 0) {
      gain.linearRampToValueAtTime(0, sustainTime + releaseTime);
    }
  }

  function updateProbabilities(perChannel: Record<string, ArrayLike<number>>): void {
    if (!running || !ctx) return;
    const t = ctx.currentTime;
    for (const id of Object.keys(perChannel)) {
      const bus = buses.get(id);
      if (!bus) continue;
      const probs = perChannel[id];
      if (!probs) continue;
      const count = Math.min(probs.length, bus.gains.length);
      for (let i = 0; i < count; i++) {
        const p = probs[i] as number;
        const target = Math.sqrt(p) * 0.4;
        applyEnvelope(bus.gains[i]!.gain, target, bus.config.envelope, t);
      }
    }
  }

  function getAnalysers(): AudioAnalysers {
    const channels = new Map<string, AnalyserNode>();
    for (const [id, bus] of buses.entries()) channels.set(id, bus.analyser);
    return { channels, master: masterAnalyser };
  }

  function getParams(): AudioParams {
    return {
      ...params,
      channels: params.channels.map((c) => ({ ...c, envelope: { ...c.envelope } })),
    };
  }

  return { start, stop, updateProbabilities, getAnalysers, setParams, getParams };
}
