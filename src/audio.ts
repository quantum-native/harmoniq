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
    kets.push("|" + i.toString(2).padStart(n, "0") + "\u27E9");
  }
  return kets;
}

export interface AudioParams {
  zWaveform: OscillatorType;
  xWaveform: OscillatorType;
  zVolume: number;
  xVolume: number;
  masterVolume: number;
  decay: number;
  reverb: number;
  scale: string;
  rootOctave: number;
  xOctaveOffset: number;
  numQubits: number;
}

export interface AudioAnalysers {
  z: AnalyserNode | null;
  x: AnalyserNode | null;
  master: AnalyserNode | null;
}

export interface AudioEngine {
  start(): void;
  stop(): void;
  updateProbabilities(zBasis: ArrayLike<number>, xBasis: ArrayLike<number>): void;
  getAnalysers(): AudioAnalysers;
  setParams(newParams: Partial<AudioParams>): void;
  getParams(): AudioParams;
}

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null;
  let zOscillators: OscillatorNode[] | null = null;
  let xOscillators: OscillatorNode[] | null = null;
  let zGains: GainNode[] | null = null;
  let xGains: GainNode[] | null = null;
  let masterGain: GainNode | null = null;
  let zBus: GainNode | null = null;
  let xBus: GainNode | null = null;
  let zAnalyser: AnalyserNode | null = null;
  let xAnalyser: AnalyserNode | null = null;
  let masterAnalyser: AnalyserNode | null = null;

  let reverbSend: GainNode | null = null;
  let delayNode: DelayNode | null = null;
  let feedbackGain: GainNode | null = null;
  let reverbFilter: BiquadFilterNode | null = null;

  let running = false;
  let numOscillators = 8; // current 2^numQubits

  let params: AudioParams = {
    zWaveform: "sine",
    xWaveform: "triangle",
    zVolume: 0.8,
    xVolume: 0.5,
    masterVolume: 0.5,
    decay: 0.1,
    reverb: 0.2,
    scale: "C major",
    rootOctave: 4,
    xOctaveOffset: 1,
    numQubits: 3,
  };

  function ensureContext(): void {
    if (ctx) return;
    ctx = new AudioContext();

    masterGain = ctx.createGain();
    masterGain.gain.value = params.masterVolume;

    zAnalyser = ctx.createAnalyser();
    zAnalyser.fftSize = 2048;
    xAnalyser = ctx.createAnalyser();
    xAnalyser.fftSize = 2048;
    masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 2048;

    zBus = ctx.createGain();
    zBus.gain.value = params.zVolume;
    xBus = ctx.createGain();
    xBus.gain.value = params.xVolume;

    zBus.connect(zAnalyser);
    zBus.connect(masterGain);
    xBus.connect(xAnalyser);
    xBus.connect(masterGain);

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

    buildOscillators();
  }

  function buildOscillators(): void {
    if (!ctx || !zBus || !xBus) return;
    if (zOscillators) {
      // Fade out old oscillators before stopping to avoid pops
      const t = ctx.currentTime;
      const oldZGains = zGains!;
      const oldXGains = xGains!;
      const oldZOsc = zOscillators;
      const oldXOsc = xOscillators!;
      for (let i = 0; i < oldZGains.length; i++) {
        oldZGains[i]!.gain.cancelScheduledValues(t);
        oldZGains[i]!.gain.setValueAtTime(oldZGains[i]!.gain.value, t);
        oldZGains[i]!.gain.linearRampToValueAtTime(0, t + 0.02);
        oldXGains[i]!.gain.cancelScheduledValues(t);
        oldXGains[i]!.gain.setValueAtTime(oldXGains[i]!.gain.value, t);
        oldXGains[i]!.gain.linearRampToValueAtTime(0, t + 0.02);
      }
      setTimeout(() => {
        oldZOsc.forEach((o) => { try { o.stop(); } catch(e) {} });
        oldXOsc.forEach((o) => { try { o.stop(); } catch(e) {} });
      }, 50);
    }

    numOscillators = 1 << params.numQubits;
    const zFreqs = getFreqs(params.scale, params.rootOctave, numOscillators);
    const xFreqs = getFreqs(params.scale, params.rootOctave + params.xOctaveOffset, numOscillators);

    zOscillators = [];
    xOscillators = [];
    zGains = [];
    xGains = [];

    for (let i = 0; i < numOscillators; i++) {
      const zOsc = ctx.createOscillator();
      const zGain = ctx.createGain();
      zOsc.type = params.zWaveform;
      zOsc.frequency.value = zFreqs[i]!;
      zGain.gain.value = 0;
      zOsc.connect(zGain);
      zGain.connect(zBus);
      zOsc.start();
      zOscillators.push(zOsc);
      zGains.push(zGain);

      const xOsc = ctx.createOscillator();
      const xGain = ctx.createGain();
      xOsc.type = params.xWaveform;
      xOsc.frequency.value = xFreqs[i]!;
      xGain.gain.value = 0;
      xOsc.connect(xGain);
      xGain.connect(xBus);
      xOsc.start();
      xOscillators.push(xOsc);
      xGains.push(xGain);
    }
  }

  function setParams(newParams: Partial<AudioParams>): void {
    const needRebuild =
      newParams.zWaveform !== params.zWaveform ||
      newParams.xWaveform !== params.xWaveform ||
      newParams.scale !== params.scale ||
      newParams.rootOctave !== params.rootOctave ||
      newParams.xOctaveOffset !== params.xOctaveOffset ||
      newParams.numQubits !== params.numQubits;

    Object.assign(params, newParams);

    if (!ctx) return;

    masterGain!.gain.value = params.masterVolume;
    zBus!.gain.value = params.zVolume;
    xBus!.gain.value = params.xVolume;
    reverbSend!.gain.value = params.reverb;

    if (needRebuild) buildOscillators();
  }

  function start(): void {
    ensureContext();
    if (ctx!.state === "suspended") ctx!.resume();
    running = true;
  }

  function stop(): void {
    running = false;
    if (!zGains) return;
    const t = ctx!.currentTime;
    for (let i = 0; i < zGains.length; i++) {
      zGains[i]!.gain.cancelScheduledValues(t);
      zGains[i]!.gain.setValueAtTime(zGains[i]!.gain.value, t);
      zGains[i]!.gain.linearRampToValueAtTime(0, t + 0.05);
      xGains![i]!.gain.cancelScheduledValues(t);
      xGains![i]!.gain.setValueAtTime(xGains![i]!.gain.value, t);
      xGains![i]!.gain.linearRampToValueAtTime(0, t + 0.05);
    }
  }

  function updateProbabilities(zBasis: ArrayLike<number>, xBasis: ArrayLike<number>): void {
    if (!running || !zGains) return;
    const t = ctx!.currentTime;
    const count = Math.min(zBasis.length, zGains.length);

    const attack = 0.015; // 15ms ramp to avoid clicks

    for (let i = 0; i < count; i++) {
      const zTarget = Math.sqrt(zBasis[i]!) * 0.4;
      const xTarget = Math.sqrt(xBasis[i]!) * 0.4;

      // Cancel pending automation and anchor current value
      zGains[i]!.gain.cancelScheduledValues(t);
      zGains[i]!.gain.setValueAtTime(zGains[i]!.gain.value, t);
      xGains![i]!.gain.cancelScheduledValues(t);
      xGains![i]!.gain.setValueAtTime(xGains![i]!.gain.value, t);

      // Ramp to target (never jump)
      zGains[i]!.gain.linearRampToValueAtTime(zTarget, t + attack);
      xGains![i]!.gain.linearRampToValueAtTime(xTarget, t + attack);

      if (params.decay > 0) {
        const decayTime = 0.05 + (1 - params.decay) * 2.0;
        zGains[i]!.gain.exponentialRampToValueAtTime(Math.max(zTarget * 0.001, 0.0001), t + attack + decayTime);
        xGains![i]!.gain.exponentialRampToValueAtTime(Math.max(xTarget * 0.001, 0.0001), t + attack + decayTime);
      }
    }
  }

  function getAnalysers(): AudioAnalysers {
    return { z: zAnalyser, x: xAnalyser, master: masterAnalyser };
  }

  function getParams(): AudioParams {
    return { ...params };
  }

  return { start, stop, updateProbabilities, getAnalysers, setParams, getParams };
}
