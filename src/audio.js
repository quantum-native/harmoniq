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
};

const SCALE_NAMES = Object.keys(SCALE_PATTERNS);

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Generate `count` frequencies by extending the scale pattern across octaves. */
function getFreqs(scaleName, rootOctave, count) {
  const pattern = SCALE_PATTERNS[scaleName] || SCALE_PATTERNS["C major"];
  const rootMidi = 60 + (rootOctave - 4) * 12;
  const freqs = [];
  for (let i = 0; i < count; i++) {
    const octaveOffset = Math.floor(i / pattern.length) * 12;
    const noteOffset = pattern[i % pattern.length];
    freqs.push(midiToFreq(rootMidi + octaveOffset + noteOffset));
  }
  return freqs;
}

export { SCALE_NAMES };

/** Generate note names for `count` notes. */
export function getNoteNames(scaleName, rootOctave, count) {
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const pattern = SCALE_PATTERNS[scaleName] || SCALE_PATTERNS["C major"];
  const rootMidi = 60 + (rootOctave - 4) * 12;
  const result = [];
  for (let i = 0; i < count; i++) {
    const octaveOffset = Math.floor(i / pattern.length) * 12;
    const noteOffset = pattern[i % pattern.length];
    const midi = rootMidi + octaveOffset + noteOffset;
    result.push(names[midi % 12] + Math.floor(midi / 12 - 1));
  }
  return result;
}

/** Generate basis state labels for n qubits. */
export function getBasisLabels(n) {
  const count = 1 << n;
  const labels = [];
  for (let i = 0; i < count; i++) {
    labels.push("|" + i.toString(2).padStart(n, "0") + ">");
  }
  return labels;
}

/** Generate ket labels for n qubits (using ⟩). */
export function getKets(n) {
  const count = 1 << n;
  const kets = [];
  for (let i = 0; i < count; i++) {
    kets.push("|" + i.toString(2).padStart(n, "0") + "\u27E9");
  }
  return kets;
}

export function createAudioEngine() {
  let ctx = null;
  let zOscillators = null;
  let xOscillators = null;
  let zGains = null;
  let xGains = null;
  let masterGain = null;
  let zBus = null;
  let xBus = null;
  let zAnalyser = null;
  let xAnalyser = null;
  let masterAnalyser = null;

  let reverbSend = null;
  let delayNode = null;
  let feedbackGain = null;
  let reverbFilter = null;

  let running = false;
  let numOscillators = 8; // current 2^numQubits

  let params = {
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

  function ensureContext() {
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

  function buildOscillators() {
    if (zOscillators) {
      // Fade out old oscillators before stopping to avoid pops
      const t = ctx.currentTime;
      const oldZGains = zGains;
      const oldXGains = xGains;
      const oldZOsc = zOscillators;
      const oldXOsc = xOscillators;
      for (let i = 0; i < oldZGains.length; i++) {
        oldZGains[i].gain.cancelScheduledValues(t);
        oldZGains[i].gain.setValueAtTime(oldZGains[i].gain.value, t);
        oldZGains[i].gain.linearRampToValueAtTime(0, t + 0.02);
        oldXGains[i].gain.cancelScheduledValues(t);
        oldXGains[i].gain.setValueAtTime(oldXGains[i].gain.value, t);
        oldXGains[i].gain.linearRampToValueAtTime(0, t + 0.02);
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
      zOsc.frequency.value = zFreqs[i];
      zGain.gain.value = 0;
      zOsc.connect(zGain);
      zGain.connect(zBus);
      zOsc.start();
      zOscillators.push(zOsc);
      zGains.push(zGain);

      const xOsc = ctx.createOscillator();
      const xGain = ctx.createGain();
      xOsc.type = params.xWaveform;
      xOsc.frequency.value = xFreqs[i];
      xGain.gain.value = 0;
      xOsc.connect(xGain);
      xGain.connect(xBus);
      xOsc.start();
      xOscillators.push(xOsc);
      xGains.push(xGain);
    }
  }

  function setParams(newParams) {
    const needRebuild =
      newParams.zWaveform !== params.zWaveform ||
      newParams.xWaveform !== params.xWaveform ||
      newParams.scale !== params.scale ||
      newParams.rootOctave !== params.rootOctave ||
      newParams.xOctaveOffset !== params.xOctaveOffset ||
      newParams.numQubits !== params.numQubits;

    Object.assign(params, newParams);

    if (!ctx) return;

    masterGain.gain.value = params.masterVolume;
    zBus.gain.value = params.zVolume;
    xBus.gain.value = params.xVolume;
    reverbSend.gain.value = params.reverb;

    if (needRebuild) buildOscillators();
  }

  function start() {
    ensureContext();
    if (ctx.state === "suspended") ctx.resume();
    running = true;
  }

  function stop() {
    running = false;
    if (!zGains) return;
    const t = ctx.currentTime;
    for (let i = 0; i < zGains.length; i++) {
      zGains[i].gain.cancelScheduledValues(t);
      zGains[i].gain.setValueAtTime(zGains[i].gain.value, t);
      zGains[i].gain.linearRampToValueAtTime(0, t + 0.05);
      xGains[i].gain.cancelScheduledValues(t);
      xGains[i].gain.setValueAtTime(xGains[i].gain.value, t);
      xGains[i].gain.linearRampToValueAtTime(0, t + 0.05);
    }
  }

  function updateProbabilities(zBasis, xBasis) {
    if (!running || !zGains) return;
    const t = ctx.currentTime;
    const count = Math.min(zBasis.length, zGains.length);

    const attack = 0.015; // 15ms ramp to avoid clicks

    for (let i = 0; i < count; i++) {
      const zTarget = Math.sqrt(zBasis[i]) * 0.4;
      const xTarget = Math.sqrt(xBasis[i]) * 0.4;

      // Cancel pending automation and anchor current value
      zGains[i].gain.cancelScheduledValues(t);
      zGains[i].gain.setValueAtTime(zGains[i].gain.value, t);
      xGains[i].gain.cancelScheduledValues(t);
      xGains[i].gain.setValueAtTime(xGains[i].gain.value, t);

      // Ramp to target (never jump)
      zGains[i].gain.linearRampToValueAtTime(zTarget, t + attack);
      xGains[i].gain.linearRampToValueAtTime(xTarget, t + attack);

      if (params.decay > 0) {
        const decayTime = 0.05 + (1 - params.decay) * 2.0;
        zGains[i].gain.exponentialRampToValueAtTime(Math.max(zTarget * 0.001, 0.0001), t + attack + decayTime);
        xGains[i].gain.exponentialRampToValueAtTime(Math.max(xTarget * 0.001, 0.0001), t + attack + decayTime);
      }
    }
  }

  function getAnalysers() {
    return { z: zAnalyser, x: xAnalyser, master: masterAnalyser };
  }

  function getParams() {
    return { ...params };
  }

  return { start, stop, updateProbabilities, getAnalysers, setParams, getParams };
}
