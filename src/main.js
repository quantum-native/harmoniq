import { initQuantum, createQuantumEngine } from "./quantum.js";
import { createAudioEngine, getNoteNames, getBasisLabels, getKets } from "./audio.js";
import { createCircuitEditor } from "./circuit.js";

const status = document.getElementById("status");
const circuitCanvas = document.getElementById("circuit-canvas");
const vizCanvas = document.getElementById("viz-canvas");
const waveformCanvas = document.getElementById("waveform-canvas");
const statevectorEl = document.getElementById("statevector");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const speedSlider = document.getElementById("speed-slider");
const speedLabel = document.getElementById("speed-label");
const gateButtons = document.querySelectorAll(".gate-btn");
const addStepsBtn = document.getElementById("add-steps-btn");
const removeStepsBtn = document.getElementById("remove-steps-btn");
const addQubitBtn = document.getElementById("add-qubit-btn");
const removeQubitBtn = document.getElementById("remove-qubit-btn");
const clearBtn = document.getElementById("clear-btn");
const presetButtons = document.querySelectorAll(".preset-btn");

// Generate X gates to increment a binary counter from state i to state i+1
function makeScaleGates(n) {
  const numStates = 1 << n;
  const gates = [];
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

const PRESETS = {
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
    steps: 4,
    numQubits: 3,
    gates: [
      { type: "H", qubit: 0, step: 0 },
      { type: "CNOT", control: 0, target: 1, step: 1 },
      { type: "CNOT", control: 0, target: 2, step: 2 },
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
    // High Z-correlation, zero entanglement
    steps: 4,
    numQubits: 3,
    gates: [
      { type: "H", qubit: 0, step: 0 },
      { type: "CNOT", control: 0, target: 1, step: 1 },
      { type: "M", qubit: 0, step: 2 },
    ],
  },
};

let playing = false;
let playheadStep = 0;
let lastStepTime = 0;
let animId = null;

function getStepInterval() {
  return 1000 / parseFloat(speedSlider.value);
}

async function main() {
  status.textContent = "Loading quantum forge...";

  try {
    await initQuantum();
  } catch (err) {
    status.textContent = "Failed to load quantum forge: " + err.message;
    console.error(err);
    return;
  }

  status.textContent = "Ready";

  const audio = createAudioEngine();
  const engine = createQuantumEngine();
  const editor = createCircuitEditor(circuitCanvas, onCircuitChange);

  // Gate palette
  gateButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      gateButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      editor.setActiveGate(btn.dataset.gate);
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
      const preset = PRESETS[btn.dataset.preset];
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
  function syncAudioParams() {
    audio.setParams({
      zWaveform: document.getElementById("ctrl-z-wave").value,
      xWaveform: document.getElementById("ctrl-x-wave").value,
      scale: document.getElementById("ctrl-scale").value,
      rootOctave: parseInt(document.getElementById("ctrl-octave").value),
      xOctaveOffset: parseInt(document.getElementById("ctrl-x-oct-offset").value),
      decay: parseFloat(document.getElementById("ctrl-decay").value),
      reverb: parseFloat(document.getElementById("ctrl-reverb").value),
      zVolume: parseFloat(document.getElementById("ctrl-z-vol").value),
      xVolume: parseFloat(document.getElementById("ctrl-x-vol").value),
      masterVolume: parseFloat(document.getElementById("ctrl-master").value),
    });
    const d = parseFloat(document.getElementById("ctrl-decay").value);
    document.getElementById("ctrl-decay-val").textContent = d === 0 ? "off" : Math.round(d * 100) + "%";
    document.getElementById("ctrl-reverb-val").textContent = Math.round(parseFloat(document.getElementById("ctrl-reverb").value) * 100) + "%";
    document.getElementById("ctrl-z-vol-val").textContent = Math.round(parseFloat(document.getElementById("ctrl-z-vol").value) * 100) + "%";
    document.getElementById("ctrl-x-vol-val").textContent = Math.round(parseFloat(document.getElementById("ctrl-x-vol").value) * 100) + "%";
    document.getElementById("ctrl-master-val").textContent = Math.round(parseFloat(document.getElementById("ctrl-master").value) * 100) + "%";
  }

  document.getElementById("sound-controls").addEventListener("input", syncAudioParams);
  document.getElementById("sound-controls").addEventListener("change", syncAudioParams);

  // Transport
  playBtn.addEventListener("click", () => {
    if (playing) return;
    playing = true;
    playheadStep = 0;
    lastStepTime = performance.now();
    audio.start();
    updateState();
    tick();
    status.textContent = "Playing";
  });

  stopBtn.addEventListener("click", () => {
    playing = false;
    audio.stop();
    if (animId) cancelAnimationFrame(animId);
    editor.setPlayheadPosition(-1);
    status.textContent = "Stopped";
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
      const result = engine.evaluate(circuit, step);
      audio.updateProbabilities(result.zBasis, result.xBasis);
      drawViz(result.zBasis, result.xBasis, result.numQubits);
      if (result.isMixed) {
        drawMixedState(result.branches, result.numQubits);
      } else {
        drawStateVector(result.stateVector, result.numQubits);
      }
      drawMeasures(result.measures);
    } catch (err) {
      console.error("Evaluation error:", err);
      status.textContent = "Error: " + err.message;
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
  const vizCtx = vizCanvas.getContext("2d");

  function drawViz(zBasis, xBasis, numQubits) {
    const numStates = 1 << numQubits;
    const dpr = devicePixelRatio;
    const barW = numStates <= 8 ? 22 : numStates <= 16 ? 14 : 8;
    const gap = numStates <= 8 ? 6 : numStates <= 16 ? 4 : 2;
    const groupGap = numStates <= 8 ? 8 : numStates <= 16 ? 4 : 2;
    const groupW = barW * 2 + gap;
    const totalW = numStates * (groupW + groupGap) - groupGap;
    const w = Math.max(480, totalW + 40);
    const h = 200;
    vizCanvas.width = w * dpr;
    vizCanvas.height = h * dpr;
    vizCanvas.style.width = w + "px";
    vizCanvas.style.height = h + "px";
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    vizCtx.clearRect(0, 0, w, h);
    vizCtx.fillStyle = "#1a1a2e";
    vizCtx.fillRect(0, 0, w, h);

    const startX = (w - totalW) / 2;
    const maxH = 140;
    const baseY = h - 30;

    const ap = audio.getParams();
    vizCtx.fillStyle = "#888";
    vizCtx.font = "11px monospace";
    vizCtx.textAlign = "center";
    vizCtx.fillText(`Z-basis (${ap.zWaveform})`, w * 0.35, 14);
    vizCtx.fillText(`X-basis (${ap.xWaveform})`, w * 0.7, 14);

    const basisLabels = getBasisLabels(numQubits);
    const noteNames = getNoteNames(ap.scale, ap.rootOctave, numStates);
    const labelFont = numStates <= 8 ? "9px" : numStates <= 16 ? "7px" : "6px";

    for (let i = 0; i < numStates; i++) {
      const x = startX + i * (groupW + groupGap);

      const zH = zBasis[i] * maxH;
      vizCtx.fillStyle = "#4fc3f7";
      vizCtx.globalAlpha = 0.7;
      vizCtx.fillRect(x, baseY - zH, barW, zH);
      vizCtx.globalAlpha = 1;

      const xH = xBasis[i] * maxH;
      vizCtx.fillStyle = "#ffb74d";
      vizCtx.globalAlpha = 0.7;
      vizCtx.fillRect(x + barW + gap, baseY - xH, barW, xH);
      vizCtx.globalAlpha = 1;

      vizCtx.fillStyle = "#666";
      vizCtx.font = labelFont + " monospace";
      vizCtx.textAlign = "center";
      vizCtx.fillText(basisLabels[i], x + groupW / 2, baseY + 11);
      vizCtx.fillText(noteNames[i], x + groupW / 2, baseY + 21);
    }
  }

  // Waveform visualization
  const wfCtx = waveformCanvas.getContext("2d");
  const WF_W = 480;
  const WF_H = 160;

  function setupWaveformCanvas() {
    const dpr = devicePixelRatio;
    waveformCanvas.width = WF_W * dpr;
    waveformCanvas.height = WF_H * dpr;
    waveformCanvas.style.width = WF_W + "px";
    waveformCanvas.style.height = WF_H + "px";
    wfCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  setupWaveformCanvas();

  function drawWaveforms() {
    const analysers = audio.getAnalysers();
    if (!analysers.z || !analysers.x) return;

    const bufLen = analysers.z.frequencyBinCount;
    const zData = new Float32Array(bufLen);
    const xData = new Float32Array(bufLen);
    const masterData = new Float32Array(bufLen);
    analysers.z.getFloatTimeDomainData(zData);
    analysers.x.getFloatTimeDomainData(xData);
    analysers.master.getFloatTimeDomainData(masterData);

    wfCtx.clearRect(0, 0, WF_W, WF_H);
    wfCtx.fillStyle = "#1a1a2e";
    wfCtx.fillRect(0, 0, WF_W, WF_H);

    const laneH = WF_H / 3;

    wfCtx.font = "10px monospace";
    wfCtx.textAlign = "left";

    drawWave(zData, bufLen, 0, laneH, "#4fc3f7", "Z-basis");
    drawWave(xData, bufLen, laneH, laneH, "#ffb74d", "X-basis");
    drawWave(masterData, bufLen, laneH * 2, laneH, "#8a8a9a", "mixed");

    wfCtx.strokeStyle = "#222";
    wfCtx.lineWidth = 0.5;
    for (let i = 1; i < 3; i++) {
      wfCtx.beginPath();
      wfCtx.moveTo(0, laneH * i);
      wfCtx.lineTo(WF_W, laneH * i);
      wfCtx.stroke();
    }
  }

  function drawWave(data, bufLen, yOffset, height, color, label) {
    const midY = yOffset + height / 2;

    wfCtx.strokeStyle = "#1f1f35";
    wfCtx.lineWidth = 0.5;
    wfCtx.beginPath();
    wfCtx.moveTo(0, midY);
    wfCtx.lineTo(WF_W, midY);
    wfCtx.stroke();

    wfCtx.fillStyle = color;
    wfCtx.globalAlpha = 0.5;
    wfCtx.fillText(label, 6, yOffset + 12);
    wfCtx.globalAlpha = 1;

    wfCtx.strokeStyle = color;
    wfCtx.lineWidth = 1.2;
    wfCtx.globalAlpha = 0.8;
    wfCtx.beginPath();

    const step = bufLen / WF_W;
    for (let i = 0; i < WF_W; i++) {
      const idx = Math.floor(i * step);
      const v = data[idx];
      const y = midY - v * (height * 0.45);
      if (i === 0) wfCtx.moveTo(i, y);
      else wfCtx.lineTo(i, y);
    }
    wfCtx.stroke();
    wfCtx.globalAlpha = 1;
  }

  // State vector display
  function drawStateVector(sv, numQubits) {
    const kets = getKets(numQubits);
    const numStates = 1 << numQubits;

    if (!sv) {
      statevectorEl.innerHTML = `<span class="sv-label">|&psi;&rang; =</span> <span class="sv-ket">${kets[0]}</span>`;
      return;
    }

    const terms = [];
    for (let i = 0; i < numStates; i++) {
      const re = sv[i].re;
      const im = sv[i].im;
      const mag = Math.sqrt(re * re + im * im);
      if (mag < 1e-6) continue;

      const phase = Math.atan2(im, re);
      let ampStr = formatAmp(mag, phase);
      terms.push({ ampStr, ket: kets[i] });
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

  function drawMixedState(branches, numQubits) {
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
      const terms = [];
      for (let i = 0; i < numStates; i++) {
        const re = branch.sv[i].re;
        const im = branch.sv[i].im;
        const mag = Math.sqrt(re * re + im * im);
        if (mag < 1e-6) continue;
        const phase = Math.atan2(im, re);
        terms.push({ ampStr: formatAmp(mag, phase), ket: kets[i] });
      }

      if (terms.length === 1 && terms[0].ampStr === "1") {
        html += `<span class="sv-ket">${terms[0].ket}</span>`;
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

  function formatAmp(mag, phase) {
    const phaseDeg = phase * 180 / Math.PI;
    const phaseStr = formatPhase(phaseDeg);

    let magStr;
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

  function formatPhase(deg) {
    while (deg > 180) deg -= 360;
    while (deg <= -180) deg += 360;

    if (Math.abs(deg) < 0.5) return "";
    if (Math.abs(deg - 180) < 0.5 || Math.abs(deg + 180) < 0.5) return "\u2212";

    const known = [
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
  const entBar = document.getElementById("ent-bar");
  const entVal = document.getElementById("ent-val");
  const zCorrBar = document.getElementById("z-corr-bar");
  const zCorrVal = document.getElementById("z-corr-val");
  const xCorrBar = document.getElementById("x-corr-bar");
  const xCorrVal = document.getElementById("x-corr-val");

  function drawMeasures(measures) {
    if (!measures) {
      entBar.style.width = "0%";
      entVal.textContent = "0.00";
      zCorrBar.style.width = "0%";
      zCorrVal.textContent = "0.00";
      xCorrBar.style.width = "0%";
      xCorrVal.textContent = "0.00";
      return;
    }
    const ent = Math.min(measures.entanglement, 1);
    const zc = Math.min(measures.zCorrelation, 1);
    const xc = Math.min(measures.xCorrelation, 1);
    entBar.style.width = (ent * 100) + "%";
    entVal.textContent = ent.toFixed(2);
    zCorrBar.style.width = (zc * 100) + "%";
    zCorrVal.textContent = zc.toFixed(2);
    xCorrBar.style.width = (xc * 100) + "%";
    xCorrVal.textContent = xc.toFixed(2);
  }

  // Initial draws
  const n0 = editor.getCircuit().numQubits;
  const ns0 = 1 << n0;
  drawViz(new Array(ns0).fill(0), new Array(ns0).fill(0), n0);
  drawStateVector(null, n0);
  drawMeasures(null);
  drawWaveforms();
}

main();
