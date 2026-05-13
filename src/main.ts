import { initQuantum, createQuantumEngine } from "./quantum.js";
import type {
  ChannelDirection,
  Complex,
  EvaluationResult,
  MixedBranch,
} from "./quantum.js";

// Subset of EvaluationResult that drawMeasures cares about. Lets the helper
// accept either branch of the discriminated union without re-narrowing.
type EvalLike = Pick<EvaluationResult, "channels" | "measures">;
import { createAudioEngine, getNoteNames, getBasisLabels, getKets } from "./audio.js";
import type { ChannelAudioConfig, EnvelopeParams } from "./audio.js";
import { createCircuitEditor } from "./circuit.js";
import type { Circuit, Gate, GateKind } from "./circuit.js";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`main: missing element #${id}`);
  return el as T;
}

function isGateKind(v: string | undefined): v is GateKind {
  return (
    v === "H" ||
    v === "X" ||
    v === "Z" ||
    v === "T" ||
    v === "CTRL" ||
    v === "M"
  );
}

const status = byId<HTMLElement>("status");
const circuitCanvas = byId<HTMLCanvasElement>("circuit-canvas");
const vizCanvas = byId<HTMLCanvasElement>("viz-canvas");
const waveformCanvas = byId<HTMLCanvasElement>("waveform-canvas");
const statevectorEl = byId<HTMLElement>("statevector");
const playBtn = byId<HTMLButtonElement>("play-btn");
const speedSlider = byId<HTMLInputElement>("speed-slider");
const speedLabel = byId<HTMLElement>("speed-label");
const gateButtons = document.querySelectorAll<HTMLButtonElement>(".gate-btn");
const addStepsBtn = byId<HTMLButtonElement>("add-steps-btn");
const removeStepsBtn = byId<HTMLButtonElement>("remove-steps-btn");
const addQubitBtn = byId<HTMLButtonElement>("add-qubit-btn");
const removeQubitBtn = byId<HTMLButtonElement>("remove-qubit-btn");
const clearBtn = byId<HTMLButtonElement>("clear-btn");
const presetButtons = document.querySelectorAll<HTMLButtonElement>(".preset-btn");

// Generate X gates to increment a binary counter from state i to state i+1
function makeScaleGates(n: number): Gate[] {
  const numStates = 1 << n;
  const gates: Gate[] = [];
  for (let i = 0; i < numStates - 1; i++) {
    const diff = i ^ (i + 1); // bits that flip
    for (let b = 0; b < n; b++) {
      if (diff & (1 << (n - 1 - b))) {
        gates.push({ type: "X", qubit: b, step: i + 1 });
      }
    }
  }
  return gates;
}

const PRESETS: Record<string, Circuit> = {
  superposition: {
    steps: 2,
    numQubits: 3,
    gates: [
      { type: "H", qubit: 0, step: 0 },
      { type: "H", qubit: 1, step: 0 },
      { type: "H", qubit: 2, step: 0 },
    ],
  },
  ghz: {
    // H on q0, then CNOT q0→q1, then CNOT q0→q2
    steps: 4,
    numQubits: 3,
    gates: [
      { type: "H", qubit: 0, step: 0 },
      { type: "CTRL", qubit: 0, step: 1 },
      { type: "X", qubit: 1, step: 1 },
      { type: "CTRL", qubit: 0, step: 2 },
      { type: "X", qubit: 2, step: 2 },
    ],
  },
  product: {
    steps: 3,
    numQubits: 3,
    gates: [
      { type: "H", qubit: 0, step: 0 },
      { type: "H", qubit: 1, step: 0 },
      { type: "T", qubit: 1, step: 1 },
      { type: "X", qubit: 2, step: 0 },
      { type: "H", qubit: 2, step: 1 },
    ],
  },
  scale: {
    steps: 9,
    numQubits: 3,
    gates: makeScaleGates(3),
  },
  classical: {
    // H + CNOT creates Bell state (entangled), then measurement collapses it
    // to a classically correlated mixture: 50% |00⟩ + 50% |11⟩
    steps: 4,
    numQubits: 3,
    gates: [
      { type: "H", qubit: 0, step: 0 },
      { type: "CTRL", qubit: 0, step: 1 },
      { type: "X", qubit: 1, step: 1 },
      { type: "M", qubit: 0, step: 2 },
    ],
  },
};

// Sampling channels: Bloch directions per channel. For now hard-coded to the
// pair the v0.3 UI exposed (Z and X). User-defined channels arrive in a later
// step of the channels refactor.
const CHANNELS: ChannelDirection[] = [
  { id: "z", theta: 0, phi: 0 },             // +ẑ — computational basis
  { id: "x", theta: Math.PI / 2, phi: 0 },   // +x̂ — Hadamard-rotated basis
];

// Adapter: pull the (Z, X) probability arrays out of the per-channel result
// shape so the still-Z-and-X-only probability viz keeps working. Removed in
// step 3 when the viz becomes per-channel.
function unpackZX(result: EvalLike): { zBasis: number[]; xBasis: number[] } {
  return {
    zBasis: result.channels[0]?.probabilities ?? [],
    xBasis: result.channels[1]?.probabilities ?? [],
  };
}

// Adapter: project the evaluation result onto the `Record<id, probs>` shape
// the N-channel audio engine consumes.
function toChannelProbs(result: EvalLike): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const ch of result.channels) out[ch.id] = ch.probabilities;
  return out;
}

let playing = false;
let playheadStep = 0;
let lastStepTime = 0;
let animId: number | null = null;

function getStepInterval(): number {
  return 1000 / parseFloat(speedSlider.value);
}

async function main(): Promise<void> {
  status.textContent = "Loading quantum forge...";

  try {
    await initQuantum();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    status.textContent = "Failed to load quantum forge: " + msg;
    console.error(err);
    return;
  }

  status.textContent = "Ready";

  const audio = createAudioEngine();
  const engine = createQuantumEngine();
  const editor = createCircuitEditor(circuitCanvas, onCircuitChange);

  // Gate palette: click to select, drag to place
  gateButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      gateButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const gate = btn.dataset.gate;
      if (isGateKind(gate)) {
        editor.setActiveGate(gate);
      }
    });

    // HTML5 drag and drop
    btn.setAttribute("draggable", "true");
    btn.addEventListener("dragstart", (e) => {
      const type = btn.dataset.gate;
      if (!e.dataTransfer || !isGateKind(type)) return;
      e.dataTransfer.setData("application/x-harmoniq-gate", type);
      e.dataTransfer.setData("text/plain", type);
      e.dataTransfer.effectAllowed = "copy";
      // Stash the type globally so dragover handlers can read it (dataTransfer
      // is restricted during dragover for security reasons in some browsers)
      window.__harmoniqDragType = type;
    });
    btn.addEventListener("dragend", () => {
      window.__harmoniqDragType = null;
    });
  });

  addStepsBtn.addEventListener("click", () => editor.addSteps(1));
  removeStepsBtn.addEventListener("click", () => editor.removeStep());
  addQubitBtn.addEventListener("click", () => {
    editor.addQubit();
    syncQubitCount();
  });
  removeQubitBtn.addEventListener("click", () => {
    editor.removeQubit();
    syncQubitCount();
  });
  clearBtn.addEventListener("click", () => editor.clear());

  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.preset;
      if (!key) return;
      const preset = PRESETS[key];
      if (preset) {
        editor.loadCircuit(preset);
        syncQubitCount();
      }
    });
  });

  function syncQubitCount() {
    const n = editor.getCircuit().numQubits;
    audio.setParams({ numQubits: n });
  }

  speedSlider.addEventListener("input", () => {
    speedLabel.textContent = `${speedSlider.value} steps/s`;
  });

  // Sound controls
  //
  // The HTML still exposes the flat v0.3 Z/X controls. Translate them here
  // into a 2-element ChannelAudioConfig[] for the N-channel audio engine.
  // Step 3 of the channels refactor replaces this with per-channel UI.
  function envelopeFromDecaySlider(decay: number): EnvelopeParams {
    if (decay <= 0) {
      // "off" — hold the note at full target, no decay or release
      return { attack: 0.015, decay: 0.001, sustain: 1, release: 0 };
    }
    // Same shape as the v0.3 engine: 15ms attack, decay to near-zero over
    // 0.05 + (1 - decay) * 2.0 seconds, no sustain, no release tail.
    return {
      attack: 0.015,
      decay: 0.05 + (1 - decay) * 2.0,
      sustain: 0.0001,
      release: 0,
    };
  }

  function syncAudioParams() {
    const decay = parseFloat(byId<HTMLInputElement>("ctrl-decay").value);
    const envelope = envelopeFromDecaySlider(decay);
    const channels: ChannelAudioConfig[] = [
      {
        id: "z",
        waveform: byId<HTMLSelectElement>("ctrl-z-wave").value as OscillatorType,
        octaveOffset: 0,
        volume: parseFloat(byId<HTMLInputElement>("ctrl-z-vol").value),
        envelope,
        muted: false,
      },
      {
        id: "x",
        waveform: byId<HTMLSelectElement>("ctrl-x-wave").value as OscillatorType,
        octaveOffset: parseInt(byId<HTMLSelectElement>("ctrl-x-oct-offset").value),
        volume: parseFloat(byId<HTMLInputElement>("ctrl-x-vol").value),
        envelope,
        muted: false,
      },
    ];
    audio.setParams({
      scale: byId<HTMLSelectElement>("ctrl-scale").value,
      rootOctave: parseInt(byId<HTMLSelectElement>("ctrl-octave").value),
      reverb: parseFloat(byId<HTMLInputElement>("ctrl-reverb").value),
      masterVolume: parseFloat(byId<HTMLInputElement>("ctrl-master").value),
      channels,
    });
    byId<HTMLElement>("ctrl-decay-val").textContent = decay === 0 ? "off" : Math.round(decay * 100) + "%";
    byId<HTMLElement>("ctrl-reverb-val").textContent = Math.round(parseFloat(byId<HTMLInputElement>("ctrl-reverb").value) * 100) + "%";
    byId<HTMLElement>("ctrl-z-vol-val").textContent = Math.round(parseFloat(byId<HTMLInputElement>("ctrl-z-vol").value) * 100) + "%";
    byId<HTMLElement>("ctrl-x-vol-val").textContent = Math.round(parseFloat(byId<HTMLInputElement>("ctrl-x-vol").value) * 100) + "%";
    byId<HTMLElement>("ctrl-master-val").textContent = Math.round(parseFloat(byId<HTMLInputElement>("ctrl-master").value) * 100) + "%";
  }

  byId<HTMLElement>("sound-controls").addEventListener("input", syncAudioParams);
  byId<HTMLElement>("sound-controls").addEventListener("change", syncAudioParams);

  // Push the initial channel set into the audio engine so buses exist before
  // the first Play. The engine's default channels list is empty.
  syncAudioParams();

  // Transport
  function startPlayback() {
    if (playing) return;
    playing = true;
    playheadStep = 0;
    lastStepTime = performance.now();
    audio.start();
    updateState();
    tick();
    status.textContent = "Playing";
    playBtn.textContent = "■ Stop";
    playBtn.classList.add("playing");
  }

  function stopPlayback() {
    if (!playing) return;
    playing = false;
    audio.stop();
    if (animId !== null) cancelAnimationFrame(animId);
    editor.setPlayheadPosition(-1);
    status.textContent = "Ready";
    playBtn.textContent = "▶ Play";
    playBtn.classList.remove("playing");
  }

  playBtn.addEventListener("click", () => {
    if (playing) stopPlayback();
    else startPlayback();
  });

  function onCircuitChange() {
    syncQubitCount();
    engine.invalidate();
    if (playing) updateState();
  }

  function updateState() {
    const circuit = editor.getCircuit();
    const step = Math.min(playheadStep, circuit.steps - 1);
    editor.setPlayheadPosition(step);

    try {
      const result = engine.evaluate(circuit, step, CHANNELS);
      audio.updateProbabilities(toChannelProbs(result));
      const { zBasis, xBasis } = unpackZX(result);
      drawViz(zBasis, xBasis, result.numQubits);
      if (result.isMixed) {
        drawMixedState(result.branches, result.numQubits);
      } else {
        drawStateVector(result.stateVector, result.numQubits);
      }
      drawMeasures(result);
    } catch (err) {
      console.error("Evaluation error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = "Error: " + msg;
    }
  }

  function tick() {
    if (!playing) return;
    animId = requestAnimationFrame(tick);

    const now = performance.now();
    const interval = getStepInterval();
    if (now - lastStepTime >= interval) {
      lastStepTime = now;
      playheadStep++;
      if (playheadStep >= editor.getCircuit().steps) {
        playheadStep = 0;
      }
      updateState();
    }

    drawWaveforms();
  }

  // Probability visualization
  const vizCtx: CanvasRenderingContext2D = (() => {
    const c = vizCanvas.getContext("2d");
    if (!c) throw new Error("main: viz canvas 2D context unavailable");
    return c;
  })();

  function drawViz(zBasis: number[], xBasis: number[], numQubits: number) {
    const numStates = 1 << numQubits;
    const dpr = devicePixelRatio;
    // Fit to container width
    const containerW = vizCanvas.parentElement?.clientWidth ?? 0;
    const w = Math.max(360, containerW);
    const h = 220;

    // Compute bar geometry to fit the available width
    const usableW = w - 40;
    const groupGap = numStates <= 8 ? 12 : numStates <= 16 ? 6 : 3;
    const groupW = (usableW - (numStates - 1) * groupGap) / numStates;
    const gap = Math.max(2, Math.min(8, groupW * 0.12));
    const barW = (groupW - gap) / 2;
    const totalW = numStates * groupW + (numStates - 1) * groupGap;

    vizCanvas.width = w * dpr;
    vizCanvas.height = h * dpr;
    vizCanvas.style.width = w + "px";
    vizCanvas.style.height = h + "px";
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    vizCtx.clearRect(0, 0, w, h);
    vizCtx.fillStyle = "#0c1018";
    vizCtx.fillRect(0, 0, w, h);

    // Subtle baseline grid
    vizCtx.strokeStyle = "#182035";
    vizCtx.lineWidth = 0.5;
    const maxH = 150;
    const baseY = h - 36;
    for (let i = 0; i <= 4; i++) {
      const y = baseY - (maxH / 4) * i;
      vizCtx.beginPath();
      vizCtx.moveTo(20, y);
      vizCtx.lineTo(w - 20, y);
      vizCtx.stroke();
    }

    const startX = (w - totalW) / 2;

    const ap = audio.getParams();
    const zWave = ap.channels.find((c) => c.id === "z")?.waveform ?? "sine";
    const xWave = ap.channels.find((c) => c.id === "x")?.waveform ?? "sine";
    vizCtx.fillStyle = "#22d3ee";
    vizCtx.globalAlpha = 0.8;
    vizCtx.font = "10px 'Chakra Petch', monospace";
    vizCtx.textAlign = "center";
    vizCtx.fillText(`Z-BASIS — ${zWave.toUpperCase()}`, w * 0.32, 16);
    vizCtx.fillStyle = "#fbbf24";
    vizCtx.fillText(`X-BASIS — ${xWave.toUpperCase()}`, w * 0.68, 16);
    vizCtx.globalAlpha = 1;

    const basisLabels = getBasisLabels(numQubits);
    const noteNames = getNoteNames(ap.scale, ap.rootOctave, numStates);
    const labelFont = numStates <= 8 ? "9px" : numStates <= 16 ? "7px" : "6px";

    for (let i = 0; i < numStates; i++) {
      const x = startX + i * (groupW + groupGap);

      const zProb = zBasis[i] ?? 0;
      const xProb = xBasis[i] ?? 0;

      const zH = zProb * maxH;
      // Z bar with glow
      vizCtx.shadowColor = "#22d3ee";
      vizCtx.shadowBlur = zProb > 0.05 ? 8 : 0;
      vizCtx.fillStyle = "#22d3ee";
      vizCtx.globalAlpha = 0.85;
      vizCtx.fillRect(x, baseY - zH, barW, zH);

      const xH = xProb * maxH;
      vizCtx.shadowColor = "#fbbf24";
      vizCtx.shadowBlur = xProb > 0.05 ? 8 : 0;
      vizCtx.fillStyle = "#fbbf24";
      vizCtx.fillRect(x + barW + gap, baseY - xH, barW, xH);

      vizCtx.shadowBlur = 0;
      vizCtx.globalAlpha = 1;

      vizCtx.fillStyle = "#475569";
      vizCtx.font = labelFont + " 'Chakra Petch', monospace";
      vizCtx.textAlign = "center";
      vizCtx.fillText(basisLabels[i] ?? "", x + groupW / 2, baseY + 11);
      vizCtx.fillStyle = "#64748b";
      vizCtx.fillText(noteNames[i] ?? "", x + groupW / 2, baseY + 21);
    }
  }

  // Waveform visualization
  const wfCtx: CanvasRenderingContext2D = (() => {
    const c = waveformCanvas.getContext("2d");
    if (!c) throw new Error("main: waveform canvas 2D context unavailable");
    return c;
  })();
  let WF_W = 480;
  const WF_H = 200;

  function setupWaveformCanvas() {
    const dpr = devicePixelRatio;
    WF_W = waveformCanvas.parentElement?.clientWidth || 480;
    waveformCanvas.width = WF_W * dpr;
    waveformCanvas.height = WF_H * dpr;
    waveformCanvas.style.width = WF_W + "px";
    waveformCanvas.style.height = WF_H + "px";
    wfCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  setupWaveformCanvas();
  window.addEventListener("resize", () => {
    setupWaveformCanvas();
    drawWaveforms();
  });

  function drawWaveforms() {
    if ((waveformCanvas.parentElement?.clientWidth ?? WF_W) !== WF_W) {
      setupWaveformCanvas();
    }

    wfCtx.clearRect(0, 0, WF_W, WF_H);
    wfCtx.fillStyle = "#0c1018";
    wfCtx.fillRect(0, 0, WF_W, WF_H);

    const laneH = WF_H / 3;

    wfCtx.font = "9px 'Chakra Petch', monospace";
    wfCtx.textAlign = "left";

    const analysers = audio.getAnalysers();
    const zAn = analysers.channels.get("z");
    const xAn = analysers.channels.get("x");
    const masterAn = analysers.master;

    if (zAn && xAn && masterAn) {
      const bufLen = zAn.frequencyBinCount;
      const zData = new Float32Array(bufLen);
      const xData = new Float32Array(bufLen);
      const masterData = new Float32Array(bufLen);
      zAn.getFloatTimeDomainData(zData);
      xAn.getFloatTimeDomainData(xData);
      masterAn.getFloatTimeDomainData(masterData);

      drawWave(zData, bufLen, 0, laneH, "#22d3ee", "Z-BASIS");
      drawWave(xData, bufLen, laneH, laneH, "#fbbf24", "X-BASIS");
      drawWave(masterData, bufLen, laneH * 2, laneH, "#94a3b8", "MIXED OUT");
    } else {
      // Empty state — show lane labels and center lines
      drawWaveEmpty(0, laneH, "#22d3ee", "Z-BASIS");
      drawWaveEmpty(laneH, laneH, "#fbbf24", "X-BASIS");
      drawWaveEmpty(laneH * 2, laneH, "#94a3b8", "MIXED OUT");
    }

    wfCtx.strokeStyle = "#182035";
    wfCtx.lineWidth = 0.5;
    for (let i = 1; i < 3; i++) {
      wfCtx.beginPath();
      wfCtx.moveTo(0, laneH * i);
      wfCtx.lineTo(WF_W, laneH * i);
      wfCtx.stroke();
    }
  }

  function drawWaveEmpty(yOffset: number, height: number, color: string, label: string) {
    const midY = yOffset + height / 2;

    // Center line
    wfCtx.strokeStyle = "#182035";
    wfCtx.lineWidth = 0.5;
    wfCtx.beginPath();
    wfCtx.moveTo(0, midY);
    wfCtx.lineTo(WF_W, midY);
    wfCtx.stroke();

    // Label
    wfCtx.fillStyle = color;
    wfCtx.globalAlpha = 0.45;
    wfCtx.fillText(label, 8, yOffset + 13);
    wfCtx.globalAlpha = 0.2;
    wfCtx.font = "8px 'Chakra Petch', monospace";
    wfCtx.fillText("— SIGNAL OFFLINE —", WF_W / 2 - 50, midY + 4);
    wfCtx.font = "9px 'Chakra Petch', monospace";
    wfCtx.globalAlpha = 1;
  }

  function drawWave(
    data: Float32Array,
    bufLen: number,
    yOffset: number,
    height: number,
    color: string,
    label: string,
  ) {
    const midY = yOffset + height / 2;

    wfCtx.strokeStyle = "#182035";
    wfCtx.lineWidth = 0.5;
    wfCtx.beginPath();
    wfCtx.moveTo(0, midY);
    wfCtx.lineTo(WF_W, midY);
    wfCtx.stroke();

    wfCtx.fillStyle = color;
    wfCtx.globalAlpha = 0.45;
    wfCtx.fillText(label, 8, yOffset + 13);
    wfCtx.globalAlpha = 1;

    wfCtx.strokeStyle = color;
    wfCtx.shadowColor = color;
    wfCtx.shadowBlur = 4;
    wfCtx.lineWidth = 1.4;
    wfCtx.globalAlpha = 0.9;
    wfCtx.beginPath();

    const step = bufLen / WF_W;
    for (let i = 0; i < WF_W; i++) {
      const idx = Math.floor(i * step);
      const v = data[idx] ?? 0;
      const y = midY - v * (height * 0.45);
      if (i === 0) wfCtx.moveTo(i, y);
      else wfCtx.lineTo(i, y);
    }
    wfCtx.stroke();
    wfCtx.shadowBlur = 0;
    wfCtx.globalAlpha = 1;
  }

  // State vector display
  function drawStateVector(sv: Complex[] | null, numQubits: number) {
    const kets = getKets(numQubits);
    const numStates = 1 << numQubits;

    if (!sv) {
      statevectorEl.innerHTML = `<span class="sv-label">|&psi;&rang; =</span> <span class="sv-ket">${kets[0] ?? ""}</span>`;
      return;
    }

    const terms: { ampStr: string; ket: string }[] = [];
    for (let i = 0; i < numStates; i++) {
      const amp = sv[i];
      if (!amp) continue;
      const re = amp.re;
      const im = amp.im;
      const mag = Math.sqrt(re * re + im * im);
      if (mag < 1e-6) continue;

      const phase = Math.atan2(im, re);
      const ampStr = formatAmp(mag, phase);
      terms.push({ ampStr, ket: kets[i] ?? "" });
    }

    if (terms.length === 0) {
      statevectorEl.innerHTML = '<span class="sv-label">|&psi;&rang; =</span> <span class="sv-amp">0</span>';
      return;
    }

    let html = '<span class="sv-label">|&psi;&rang; =</span> ';
    terms.forEach((t, idx) => {
      if (idx > 0) html += '<span class="sv-plus">+</span>';
      html += `<span class="sv-term"><span class="sv-amp">${t.ampStr}</span><span class="sv-ket">${t.ket}</span></span>`;
    });
    statevectorEl.innerHTML = html;
  }

  function drawMixedState(branches: MixedBranch[], numQubits: number) {
    const kets = getKets(numQubits);
    const numStates = 1 << numQubits;

    if (!branches || branches.length === 0) {
      statevectorEl.innerHTML = '<span class="sv-label">\u03C1 =</span> <span class="sv-amp">0</span>';
      return;
    }

    let html = '<span class="sv-label">\u03C1 =</span> ';
    branches.forEach((branch, bIdx) => {
      if (bIdx > 0) html += '<span class="sv-plus">+</span>';

      const pct = (branch.weight * 100).toFixed(0);
      html += `<span class="sv-term"><span class="sv-amp">${pct}%</span> `;

      // Show the branch state vector inline
      const terms: { ampStr: string; ket: string }[] = [];
      for (let i = 0; i < numStates; i++) {
        const amp = branch.sv[i];
        if (!amp) continue;
        const re = amp.re;
        const im = amp.im;
        const mag = Math.sqrt(re * re + im * im);
        if (mag < 1e-6) continue;
        const phase = Math.atan2(im, re);
        terms.push({ ampStr: formatAmp(mag, phase), ket: kets[i] ?? "" });
      }

      if (terms.length === 1 && terms[0]!.ampStr === "1") {
        html += `<span class="sv-ket">${terms[0]!.ket}</span>`;
      } else {
        html += "(";
        terms.forEach((t, idx) => {
          if (idx > 0) html += '<span class="sv-plus">+</span>';
          html += `<span class="sv-amp">${t.ampStr}</span><span class="sv-ket">${t.ket}</span>`;
        });
        html += ")";
      }
      html += "</span>";
    });
    statevectorEl.innerHTML = html;
  }

  function formatAmp(mag: number, phase: number): string {
    const phaseDeg = phase * 180 / Math.PI;
    const phaseStr = formatPhase(phaseDeg);

    let magStr: string;
    if (Math.abs(mag - 1) < 1e-4) {
      magStr = "";
    } else if (Math.abs(mag - 0.5) < 1e-4) {
      magStr = "\u00BD";
    } else if (Math.abs(mag - Math.SQRT1_2) < 1e-4) {
      magStr = "1/\u221A2";
    } else if (Math.abs(mag - 0.5 * Math.SQRT1_2) < 1e-4) {
      magStr = "1/2\u221A2";
    } else if (Math.abs(mag - Math.sqrt(0.125)) < 1e-4) {
      magStr = "1/\u221A8";
    } else if (Math.abs(mag - 0.25) < 1e-4) {
      magStr = "\u00BC";
    } else {
      magStr = mag.toFixed(3);
    }

    if (phaseStr === "") {
      return magStr || "1";
    }
    if (phaseStr === "\u2212") {
      return magStr ? `\u2212${magStr}` : "\u22121";
    }
    const body = magStr || "1";
    return `${body}<span class="sv-phase">${phaseStr}</span>`;
  }

  function formatPhase(deg: number): string {
    while (deg > 180) deg -= 360;
    while (deg <= -180) deg += 360;

    if (Math.abs(deg) < 0.5) return "";
    if (Math.abs(deg - 180) < 0.5 || Math.abs(deg + 180) < 0.5) return "\u2212";

    const known: [number, string][] = [
      [45,  "e^{i\u03C0/4}"],
      [90,  "i"],
      [135, "e^{i3\u03C0/4}"],
      [-45, "e^{-i\u03C0/4}"],
      [-90, "-i"],
      [-135,"e^{-i3\u03C0/4}"],
      [60,  "e^{i\u03C0/3}"],
      [-60, "e^{-i\u03C0/3}"],
    ];
    for (const [d, label] of known) {
      if (Math.abs(deg - d) < 0.5) return label;
    }

    return `e^{i${(deg * Math.PI / 180).toFixed(2)}}`;
  }

  // Measures display
  const entBar = byId<HTMLElement>("ent-bar");
  const entVal = byId<HTMLElement>("ent-val");
  const zCorrBar = byId<HTMLElement>("z-corr-bar");
  const zCorrVal = byId<HTMLElement>("z-corr-val");
  const xCorrBar = byId<HTMLElement>("x-corr-bar");
  const xCorrVal = byId<HTMLElement>("x-corr-val");

  function drawMeasures(result: EvalLike | null | undefined) {
    if (!result) {
      entBar.style.width = "0%";
      entVal.textContent = "0.00";
      zCorrBar.style.width = "0%";
      zCorrVal.textContent = "0.00";
      xCorrBar.style.width = "0%";
      xCorrVal.textContent = "0.00";
      return;
    }
    const ent = Math.min(result.measures.entanglement, 1);
    const zc = Math.min(result.channels[0]?.correlation ?? 0, 1);
    const xc = Math.min(result.channels[1]?.correlation ?? 0, 1);
    entBar.style.width = (ent * 100) + "%";
    entVal.textContent = ent.toFixed(2);
    zCorrBar.style.width = (zc * 100) + "%";
    zCorrVal.textContent = zc.toFixed(2);
    xCorrBar.style.width = (xc * 100) + "%";
    xCorrVal.textContent = xc.toFixed(2);
  }

  // Resize handling
  window.addEventListener("resize", () => {
    // Re-evaluate to redraw at new sizes
    const circuit = editor.getCircuit();
    const result = engine.evaluate(circuit, -1, CHANNELS);
    const { zBasis, xBasis } = unpackZX(result);
    drawViz(zBasis, xBasis, result.numQubits);
    drawWaveforms();
  });

  // Initial draws — evaluate the empty circuit at step -1 (just |0...0⟩)
  const initial = engine.evaluate(editor.getCircuit(), -1, CHANNELS);
  const initialZX = unpackZX(initial);
  drawViz(initialZX.zBasis, initialZX.xBasis, initial.numQubits);
  if (initial.isMixed) {
    drawMixedState(initial.branches, initial.numQubits);
  } else {
    drawStateVector(initial.stateVector, initial.numQubits);
  }
  drawMeasures(initial);
  drawWaveforms();
}

main();
