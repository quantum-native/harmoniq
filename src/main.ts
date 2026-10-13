import { initQuantum, createQuantumEngine } from "./quantum.js";
import type { Complex, EvaluationResult, MixedBranch } from "./quantum.js";
import { createAudioEngine, getNoteNames, getBasisLabels, getKets } from "./audio.js";
import { createCircuitEditor } from "./circuit.js";
import type { Circuit, Gate, GateKind } from "./circuit.js";
import {
  createChannelsStore,
  defaultChannels,
  toAudioConfig,
  toDirection,
  MAX_CHANNELS,
} from "./channels.js";
import type { Channel } from "./channels.js";
import { createBlochHUD } from "./bloch.js";
import type { BlochHUD } from "./bloch.js";

// Subset of EvaluationResult that drawMeasures cares about. Lets the helper
// accept either branch of the discriminated union without re-narrowing.
type EvalLike = Pick<EvaluationResult, "channels" | "measures">;

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
  const channelsStore = createChannelsStore(defaultChannels());
  const channelsListEl = byId<HTMLElement>("channels-list");
  const addChannelBtn = byId<HTMLButtonElement>("add-channel-btn");
  // Card DOM references keyed by channel id so per-card UI updates (correlation
  // readouts, value labels) can be applied without re-rendering the whole list.
  const cardEls = new Map<string, ChannelCardEls>();

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

  // ── Channel card construction ───────────────────────────────────────

  interface ChannelCardEls {
    root: HTMLElement;
    nameInput: HTMLInputElement;
    muteBtn: HTMLButtonElement;
    deleteBtn: HTMLButtonElement;
    blochCanvas: HTMLCanvasElement;
    bloch: BlochHUD;
    snapInput: HTMLInputElement;
    thetaInput: HTMLInputElement;
    thetaVal: HTMLElement;
    thetaDec: HTMLButtonElement;
    thetaInc: HTMLButtonElement;
    phiInput: HTMLInputElement;
    phiVal: HTMLElement;
    phiDec: HTMLButtonElement;
    phiInc: HTMLButtonElement;
    waveformSelect: HTMLSelectElement;
    octSelect: HTMLSelectElement;
    decayInput: HTMLInputElement;
    decayVal: HTMLElement;
    volInput: HTMLInputElement;
    volVal: HTMLElement;
    corrVal: HTMLElement;
  }

  // Snap-step for both axes and for the ‹›  stepper buttons.
  const SNAP_STEP = Math.PI / 8;

  function buildChannelCard(ch: Channel): ChannelCardEls {
    const root = document.createElement("div");
    root.className = "channel-card";
    root.dataset.id = ch.id;
    root.style.setProperty("--accent", ch.color);
    root.innerHTML = `
      <div class="channel-card-head">
        <input type="text" class="channel-name" maxlength="24">
        <div class="channel-card-actions">
          <button type="button" class="channel-mute" title="Mute">M</button>
          <button type="button" class="channel-delete" title="Delete" aria-label="Delete channel">×</button>
        </div>
      </div>
      <div class="channel-basis">
        <canvas class="channel-bloch" width="180" height="180"></canvas>
        <label class="snap-toggle"><input type="checkbox" class="channel-snap"> Snap π/8</label>
        <div class="basis-control">
          <span class="basis-label">θ</span>
          <div class="basis-stepper">
            <button type="button" class="basis-step" data-dir="-1" data-axis="theta" aria-label="Decrease θ">‹</button>
            <input type="range" class="channel-theta" min="0" max="${Math.PI.toFixed(6)}" step="0.01">
            <button type="button" class="basis-step" data-dir="1" data-axis="theta" aria-label="Increase θ">›</button>
          </div>
          <span class="basis-val channel-theta-val">0</span>
        </div>
        <div class="basis-control">
          <span class="basis-label">φ</span>
          <div class="basis-stepper">
            <button type="button" class="basis-step" data-dir="-1" data-axis="phi" aria-label="Decrease φ">‹</button>
            <input type="range" class="channel-phi" min="0" max="${(2 * Math.PI).toFixed(6)}" step="0.01">
            <button type="button" class="basis-step" data-dir="1" data-axis="phi" aria-label="Increase φ">›</button>
          </div>
          <span class="basis-val channel-phi-val">0</span>
        </div>
      </div>
      <div class="channel-sound">
        <div class="channel-row">
          <div class="channel-row-head"><span>Wave</span></div>
          <select class="channel-wave">
            <option value="sine">sine</option>
            <option value="triangle">triangle</option>
            <option value="square">square</option>
            <option value="sawtooth">sawtooth</option>
          </select>
        </div>
        <div class="channel-row">
          <div class="channel-row-head"><span>Oct</span></div>
          <select class="channel-oct">
            <option value="-2">−2</option>
            <option value="-1">−1</option>
            <option value="0">0</option>
            <option value="1">+1</option>
            <option value="2">+2</option>
          </select>
        </div>
        <div class="channel-row">
          <div class="channel-row-head"><span>Decay</span><span class="channel-row-val channel-decay-val"></span></div>
          <input type="range" class="channel-decay" min="0" max="1" step="0.01">
        </div>
        <div class="channel-row">
          <div class="channel-row-head"><span>Vol</span><span class="channel-row-val channel-vol-val"></span></div>
          <input type="range" class="channel-vol" min="0" max="1" step="0.01">
        </div>
      </div>
      <div class="channel-corr">
        <span>Correlation</span>
        <span class="channel-corr-val">0.00</span>
      </div>
    `;
    const find = <T extends HTMLElement>(sel: string): T => {
      const el = root.querySelector<T>(sel);
      if (!el) throw new Error(`channel card ${ch.id}: missing ${sel}`);
      return el;
    };
    const blochCanvas = find<HTMLCanvasElement>(".channel-bloch");
    const bloch = createBlochHUD(blochCanvas, {
      color: ch.color,
      initialTheta: ch.theta,
      initialPhi: ch.phi,
    });
    const els: ChannelCardEls = {
      root,
      nameInput: find<HTMLInputElement>(".channel-name"),
      muteBtn: find<HTMLButtonElement>(".channel-mute"),
      deleteBtn: find<HTMLButtonElement>(".channel-delete"),
      blochCanvas,
      bloch,
      snapInput: find<HTMLInputElement>(".channel-snap"),
      thetaInput: find<HTMLInputElement>(".channel-theta"),
      thetaVal: find<HTMLElement>(".channel-theta-val"),
      thetaDec: find<HTMLButtonElement>('.basis-step[data-axis="theta"][data-dir="-1"]'),
      thetaInc: find<HTMLButtonElement>('.basis-step[data-axis="theta"][data-dir="1"]'),
      phiInput: find<HTMLInputElement>(".channel-phi"),
      phiVal: find<HTMLElement>(".channel-phi-val"),
      phiDec: find<HTMLButtonElement>('.basis-step[data-axis="phi"][data-dir="-1"]'),
      phiInc: find<HTMLButtonElement>('.basis-step[data-axis="phi"][data-dir="1"]'),
      waveformSelect: find<HTMLSelectElement>(".channel-wave"),
      octSelect: find<HTMLSelectElement>(".channel-oct"),
      decayInput: find<HTMLInputElement>(".channel-decay"),
      decayVal: find<HTMLElement>(".channel-decay-val"),
      volInput: find<HTMLInputElement>(".channel-vol"),
      volVal: find<HTMLElement>(".channel-vol-val"),
      corrVal: find<HTMLElement>(".channel-corr-val"),
    };

    // Seed initial UI state from channel
    els.nameInput.value = ch.name;
    els.snapInput.checked = ch.snap;
    els.thetaInput.value = String(ch.theta);
    els.phiInput.value = String(ch.phi);
    els.thetaVal.textContent = formatPi(ch.theta);
    els.phiVal.textContent = formatPi(ch.phi);
    els.waveformSelect.value = ch.waveform;
    els.octSelect.value = String(ch.octaveOffset);
    els.decayInput.value = String(ch.decay);
    els.volInput.value = String(ch.volume);
    els.decayVal.textContent = formatPercent(ch.decay);
    els.volVal.textContent = formatPercent(ch.volume);
    if (ch.muted) {
      els.muteBtn.classList.add("active");
      root.classList.add("muted");
    }

    wireCardListeners(ch.id, els);
    return els;
  }

  function wireCardListeners(id: string, els: ChannelCardEls) {
    els.nameInput.addEventListener("input", () => {
      channelsStore.update(id, { name: els.nameInput.value });
    });
    els.muteBtn.addEventListener("click", () => {
      const current = channelsStore.get(id);
      if (!current) return;
      const muted = !current.muted;
      channelsStore.update(id, { muted });
      els.muteBtn.classList.toggle("active", muted);
      els.root.classList.toggle("muted", muted);
    });
    els.deleteBtn.addEventListener("click", () => {
      els.bloch.destroy();
      channelsStore.remove(id);
    });
    els.snapInput.addEventListener("change", () => {
      const snap = els.snapInput.checked;
      const current = channelsStore.get(id);
      if (!current) return;
      // Quantise current θ/φ on toggling snap on, so the slider thumb visibly
      // jumps to the nearest π/8 step instead of waiting for the next nudge.
      if (snap) {
        channelsStore.update(id, {
          snap,
          theta: clampTheta(snapTo(current.theta)),
          phi: wrapPhi(snapTo(current.phi)),
        });
      } else {
        channelsStore.update(id, { snap });
      }
    });
    els.thetaInput.addEventListener("input", () => {
      const snap = channelsStore.get(id)?.snap ?? false;
      const raw = parseFloat(els.thetaInput.value);
      const v = clampTheta(snap ? snapTo(raw) : raw);
      channelsStore.update(id, { theta: v });
    });
    els.phiInput.addEventListener("input", () => {
      const snap = channelsStore.get(id)?.snap ?? false;
      const raw = parseFloat(els.phiInput.value);
      const v = wrapPhi(snap ? snapTo(raw) : raw);
      channelsStore.update(id, { phi: v });
    });
    els.thetaDec.addEventListener("click", () => stepBasis(id, "theta", -1));
    els.thetaInc.addEventListener("click", () => stepBasis(id, "theta", +1));
    els.phiDec.addEventListener("click", () => stepBasis(id, "phi", -1));
    els.phiInc.addEventListener("click", () => stepBasis(id, "phi", +1));
    els.waveformSelect.addEventListener("change", () => {
      channelsStore.update(id, {
        waveform: els.waveformSelect.value as OscillatorType,
      });
    });
    els.octSelect.addEventListener("change", () => {
      channelsStore.update(id, { octaveOffset: parseInt(els.octSelect.value) });
    });
    els.decayInput.addEventListener("input", () => {
      const v = parseFloat(els.decayInput.value);
      els.decayVal.textContent = formatPercent(v);
      channelsStore.update(id, { decay: v });
    });
    els.volInput.addEventListener("input", () => {
      const v = parseFloat(els.volInput.value);
      els.volVal.textContent = formatPercent(v);
      channelsStore.update(id, { volume: v });
    });
  }

  /** Nudge θ or φ by ±π/8, snapping the result onto the π/8 grid. */
  function stepBasis(id: string, axis: "theta" | "phi", dir: 1 | -1) {
    const current = channelsStore.get(id);
    if (!current) return;
    const base = axis === "theta" ? current.theta : current.phi;
    // Snap to grid first so off-grid starting values still land cleanly.
    const next = snapTo(base) + dir * SNAP_STEP;
    if (axis === "theta") {
      channelsStore.update(id, { theta: clampTheta(next) });
    } else {
      channelsStore.update(id, { phi: wrapPhi(next) });
    }
  }

  /** Mirror a channel's basis state into the card's HUD, slider, and readout. */
  function syncCardBasis(card: ChannelCardEls, ch: Channel) {
    card.bloch.setVector(ch.theta, ch.phi);
    // setting .value to current value is a no-op and won't disturb an active drag
    card.thetaInput.value = String(ch.theta);
    card.phiInput.value = String(ch.phi);
    card.thetaVal.textContent = formatPi(ch.theta);
    card.phiVal.textContent = formatPi(ch.phi);
  }

  function snapTo(v: number): number {
    return Math.round(v / SNAP_STEP) * SNAP_STEP;
  }
  function clampTheta(t: number): number {
    return Math.max(0, Math.min(Math.PI, t));
  }
  function wrapPhi(p: number): number {
    let v = p % (2 * Math.PI);
    if (v < 0) v += 2 * Math.PI;
    return v;
  }
  function formatPi(rad: number): string {
    if (Math.abs(rad) < 1e-9) return "0";
    return (rad / Math.PI).toFixed(2) + "π";
  }
  function formatPercent(v: number): string {
    if (v <= 0) return "0%";
    return Math.round(v * 100) + "%";
  }

  // Sound controls: just the globals (scale/octave/reverb/master). Per-channel
  // settings live in the channel cards and flow through syncChannelsToAudio.
  function syncGlobals() {
    audio.setParams({
      scale: byId<HTMLSelectElement>("ctrl-scale").value,
      rootOctave: parseInt(byId<HTMLSelectElement>("ctrl-octave").value),
      reverb: parseFloat(byId<HTMLInputElement>("ctrl-reverb").value),
      masterVolume: parseFloat(byId<HTMLInputElement>("ctrl-master").value),
    });
    byId<HTMLElement>("ctrl-reverb-val").textContent = Math.round(parseFloat(byId<HTMLInputElement>("ctrl-reverb").value) * 100) + "%";
    byId<HTMLElement>("ctrl-master-val").textContent = Math.round(parseFloat(byId<HTMLInputElement>("ctrl-master").value) * 100) + "%";
  }

  function syncChannelsToAudio() {
    audio.setParams({ channels: channelsStore.list().map(toAudioConfig) });
  }

  byId<HTMLElement>("sound-controls").addEventListener("input", syncGlobals);
  byId<HTMLElement>("sound-controls").addEventListener("change", syncGlobals);

  // Seed engine + audio from defaults so buses exist before the first Play.
  syncGlobals();
  syncChannelsToAudio();
  // Any change (add/remove or per-channel field) re-pushes audio config and
  // re-evaluates so the viz and sound reflect the new channels immediately.
  // Also mirror current basis state back to each card so the HUD, slider, and
  // readout stay in sync when basis is changed from outside the slider input
  // (e.g. snap toggle quantising, or future preset loaders).
  channelsStore.subscribeAny(() => {
    syncChannelsToAudio();
    updateState();
    for (const ch of channelsStore.list()) {
      const card = cardEls.get(ch.id);
      if (card) syncCardBasis(card, ch);
    }
  });

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
      const channels = channelsStore.list();
      const result = engine.evaluate(circuit, step, channels.map(toDirection));
      const perChannel: Record<string, number[]> = {};
      for (const ch of result.channels) perChannel[ch.id] = ch.probabilities;
      audio.updateProbabilities(perChannel);
      drawViz(result, channels, result.numQubits);
      if (result.isMixed) {
        drawMixedState(result.branches, result.numQubits);
      } else {
        drawStateVector(result.stateVector, result.numQubits);
      }
      drawMeasures(result.measures.entanglement);
      updateChannelCorrelations(result);
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

  function drawViz(
    result: EvalLike,
    channels: readonly Channel[],
    numQubits: number,
  ) {
    const numStates = 1 << numQubits;
    const numChannels = Math.max(1, channels.length);
    const dpr = devicePixelRatio;
    const containerW = vizCanvas.parentElement?.clientWidth ?? 0;
    const w = Math.max(360, containerW);
    const h = 220;

    // Geometry: each basis state gets a group; each group fits N bars side by side.
    const usableW = w - 40;
    const groupGap = numStates <= 8 ? 12 : numStates <= 16 ? 6 : 3;
    const groupW = (usableW - (numStates - 1) * groupGap) / numStates;
    const innerGap = Math.max(1, Math.min(6, groupW * 0.08));
    const barW = Math.max(1, (groupW - innerGap * (numChannels - 1)) / numChannels);
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

    // Channel legend
    vizCtx.globalAlpha = 0.8;
    vizCtx.font = "10px 'Chakra Petch', monospace";
    vizCtx.textAlign = "center";
    const legendStep = w / (channels.length + 1);
    channels.forEach((ch, idx) => {
      vizCtx.fillStyle = ch.color;
      vizCtx.fillText(ch.name.toUpperCase(), legendStep * (idx + 1), 16);
    });
    vizCtx.globalAlpha = 1;

    const basisLabels = getBasisLabels(numQubits);
    const ap = audio.getParams();
    const noteNames = getNoteNames(ap.scale, ap.rootOctave, numStates);
    const labelFont = numStates <= 8 ? "9px" : numStates <= 16 ? "7px" : "6px";

    for (let i = 0; i < numStates; i++) {
      const groupX = startX + i * (groupW + groupGap);

      channels.forEach((ch, cIdx) => {
        const channelResult = result.channels[cIdx];
        const prob = channelResult?.probabilities[i] ?? 0;
        const barH = prob * maxH;
        const x = groupX + cIdx * (barW + innerGap);
        vizCtx.shadowColor = ch.color;
        vizCtx.shadowBlur = prob > 0.05 ? 8 : 0;
        vizCtx.fillStyle = ch.color;
        vizCtx.globalAlpha = 0.85;
        vizCtx.fillRect(x, baseY - barH, barW, barH);
      });
      vizCtx.shadowBlur = 0;
      vizCtx.globalAlpha = 1;

      vizCtx.fillStyle = "#475569";
      vizCtx.font = labelFont + " 'Chakra Petch', monospace";
      vizCtx.textAlign = "center";
      vizCtx.fillText(basisLabels[i] ?? "", groupX + groupW / 2, baseY + 11);
      vizCtx.fillStyle = "#64748b";
      vizCtx.fillText(noteNames[i] ?? "", groupX + groupW / 2, baseY + 21);
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

    const channels = channelsStore.list();
    const numLanes = channels.length + 1; // + 1 for the mixed master lane
    const laneH = WF_H / numLanes;

    wfCtx.font = "9px 'Chakra Petch', monospace";
    wfCtx.textAlign = "left";

    const analysers = audio.getAnalysers();
    const masterAn = analysers.master;

    channels.forEach((ch, idx) => {
      const yOffset = idx * laneH;
      const an = analysers.channels.get(ch.id);
      const label = ch.name.toUpperCase();
      if (an) {
        const bufLen = an.frequencyBinCount;
        const data = new Float32Array(bufLen);
        an.getFloatTimeDomainData(data);
        drawWave(data, bufLen, yOffset, laneH, ch.color, label);
      } else {
        drawWaveEmpty(yOffset, laneH, ch.color, label);
      }
    });

    const masterY = channels.length * laneH;
    if (masterAn) {
      const bufLen = masterAn.frequencyBinCount;
      const data = new Float32Array(bufLen);
      masterAn.getFloatTimeDomainData(data);
      drawWave(data, bufLen, masterY, laneH, "#94a3b8", "MIXED OUT");
    } else {
      drawWaveEmpty(masterY, laneH, "#94a3b8", "MIXED OUT");
    }

    wfCtx.strokeStyle = "#182035";
    wfCtx.lineWidth = 0.5;
    for (let i = 1; i < numLanes; i++) {
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

  // Measures display — channel-agnostic entanglement. Per-channel correlation
  // is shown inside each channel card.
  const entBar = byId<HTMLElement>("ent-bar");
  const entVal = byId<HTMLElement>("ent-val");

  function drawMeasures(entanglement: number | null) {
    if (entanglement === null) {
      entBar.style.width = "0%";
      entVal.textContent = "0.00";
      return;
    }
    const ent = Math.min(entanglement, 1);
    entBar.style.width = (ent * 100) + "%";
    entVal.textContent = ent.toFixed(2);
  }

  function updateChannelCorrelations(result: EvalLike) {
    for (const channel of result.channels) {
      const els = cardEls.get(channel.id);
      if (els) els.corrVal.textContent = channel.correlation.toFixed(2);
    }
  }

  // Resize handling
  window.addEventListener("resize", () => {
    const circuit = editor.getCircuit();
    const channels = channelsStore.list();
    const result = engine.evaluate(circuit, -1, channels.map(toDirection));
    drawViz(result, channels, result.numQubits);
    drawWaveforms();
  });

  // Initial render: cards, then evaluate the empty circuit at step -1
  // (just |0...0⟩) so the viz/measures show something on first paint.
  renderInitialChannels();
  const initialChannels = channelsStore.list();
  const initial = engine.evaluate(editor.getCircuit(), -1, initialChannels.map(toDirection));
  drawViz(initial, initialChannels, initial.numQubits);
  if (initial.isMixed) {
    drawMixedState(initial.branches, initial.numQubits);
  } else {
    drawStateVector(initial.stateVector, initial.numQubits);
  }
  drawMeasures(initial.measures.entanglement);
  updateChannelCorrelations(initial);
  drawWaveforms();

  // ── Channel card rendering ──────────────────────────────────────────

  function renderInitialChannels() {
    syncCardsToStore();
  }

  function syncCardsToStore() {
    const live = channelsStore.list();
    const liveIds = new Set(live.map((c) => c.id));
    // Remove cards whose channels are gone
    for (const [id, els] of cardEls.entries()) {
      if (!liveIds.has(id)) {
        els.root.remove();
        cardEls.delete(id);
      }
    }
    // Add cards for new channels (in store order)
    for (const ch of live) {
      if (!cardEls.has(ch.id)) {
        const card = buildChannelCard(ch);
        channelsListEl.appendChild(card.root);
        cardEls.set(ch.id, card);
      }
    }
    addChannelBtn.disabled = live.length >= MAX_CHANNELS;
  }

  addChannelBtn.addEventListener("click", () => {
    channelsStore.add();
  });

  channelsStore.subscribeStructure(syncCardsToStore);
}

main();
