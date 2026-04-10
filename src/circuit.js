const CELL_W = 56;
const CELL_H = 56;
const WIRE_Y_START = 40;
const LABEL_W = 40;
const GATE_RADIUS = 18;

const SINGLE_QUBIT_GATES = ["H", "X", "Z", "T", "M"];
const TWO_QUBIT_GATES = ["CNOT", "CZ", "iSWAP"];

const GATE_COLORS = {
  H: "#22d3ee",
  X: "#ff6b6b",
  Z: "#a855f7",
  T: "#fbbf24",
  M: "#64748b",
  CNOT: "#ff6b6b",
  CZ: "#a855f7",
  iSWAP: "#f472b6",
};

export function createCircuitEditor(canvas, onChange) {
  const ctx = canvas.getContext("2d");
  let circuit = { steps: 12, numQubits: 3, gates: [] };
  let activeGate = "H";
  let playheadStep = -1;
  let twoQubitPending = null;

  function wireY(qubit) {
    return WIRE_Y_START + qubit * CELL_H + CELL_H / 2;
  }

  function cellX(step) {
    return LABEL_W + step * CELL_W + CELL_W / 2;
  }

  function resize() {
    const w = LABEL_W + circuit.steps * CELL_W + 20;
    const h = WIRE_Y_START + circuit.numQubits * CELL_H + 10;
    canvas.width = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  function draw() {
    resize();
    const w = canvas.width / devicePixelRatio;
    const h = canvas.height / devicePixelRatio;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "#0c1018";
    ctx.fillRect(0, 0, w, h);

    // Wires
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1.5;
    for (let q = 0; q < circuit.numQubits; q++) {
      const y = wireY(q);
      ctx.beginPath();
      ctx.moveTo(LABEL_W, y);
      ctx.lineTo(LABEL_W + circuit.steps * CELL_W, y);
      ctx.stroke();

      ctx.fillStyle = "#64748b";
      ctx.font = "11px 'Chakra Petch', monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(`q${q}`, LABEL_W - 6, y);
    }

    // Step numbers
    ctx.fillStyle = "#334155";
    ctx.font = "9px 'Chakra Petch', monospace";
    ctx.textAlign = "center";
    for (let s = 0; s < circuit.steps; s++) {
      ctx.fillText(s, cellX(s), WIRE_Y_START - 8);
    }

    // Grid dots
    ctx.fillStyle = "#182035";
    for (let s = 0; s < circuit.steps; s++) {
      for (let q = 0; q < circuit.numQubits; q++) {
        ctx.beginPath();
        ctx.arc(cellX(s), wireY(q), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Gates
    for (const gate of circuit.gates) {
      drawGate(gate);
    }

    // Playhead
    if (playheadStep >= 0 && playheadStep < circuit.steps) {
      const x = cellX(playheadStep);
      ctx.strokeStyle = "#ff6b6b";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, WIRE_Y_START - 15);
      ctx.lineTo(x, WIRE_Y_START + circuit.numQubits * CELL_H + 5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Pending two-qubit gate indicator
    if (twoQubitPending) {
      const x = cellX(twoQubitPending.step);
      const y = wireY(twoQubitPending.qubit);
      ctx.strokeStyle = GATE_COLORS[twoQubitPending.type];
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, GATE_RADIUS + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawGate(gate) {
    const color = GATE_COLORS[gate.type] || "#fff";

    if (gate.type === "M") {
      // Measurement gate: meter symbol
      const x = cellX(gate.step);
      const y = wireY(gate.qubit);
      const r = GATE_RADIUS;

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);

      // Meter arc
      ctx.beginPath();
      ctx.arc(x, y + 4, r * 0.55, Math.PI, 0);
      ctx.stroke();
      // Meter needle
      ctx.beginPath();
      ctx.moveTo(x, y + 4);
      ctx.lineTo(x + r * 0.35, y - r * 0.35);
      ctx.stroke();

    } else if (SINGLE_QUBIT_GATES.includes(gate.type)) {
      const x = cellX(gate.step);
      const y = wireY(gate.qubit);

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15;
      ctx.fillRect(x - GATE_RADIUS, y - GATE_RADIUS, GATE_RADIUS * 2, GATE_RADIUS * 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - GATE_RADIUS, y - GATE_RADIUS, GATE_RADIUS * 2, GATE_RADIUS * 2);

      ctx.fillStyle = color;
      ctx.font = "bold 14px 'Chakra Petch', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(gate.type, x, y);
    } else if (gate.type === "CNOT") {
      const x = cellX(gate.step);
      const cy = wireY(gate.control);
      const ty = wireY(gate.target);

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.lineTo(x, ty);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, cy, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, ty, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 8, ty);
      ctx.lineTo(x + 8, ty);
      ctx.moveTo(x, ty - 8);
      ctx.lineTo(x, ty + 8);
      ctx.stroke();
    } else if (gate.type === "CZ") {
      const x = cellX(gate.step);
      const y1 = wireY(gate.control);
      const y2 = wireY(gate.target);

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y1, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y2, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = "bold 10px 'Chakra Petch', monospace";
      ctx.textAlign = "center";
      ctx.fillText("CZ", x, Math.min(y1, y2) - 14);
    } else if (gate.type === "iSWAP") {
      const x = cellX(gate.step);
      const y1 = wireY(gate.qubit1);
      const y2 = wireY(gate.qubit2);

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
      ctx.stroke();

      const drawX = (y) => {
        ctx.beginPath();
        ctx.moveTo(x - 6, y - 6);
        ctx.lineTo(x + 6, y + 6);
        ctx.moveTo(x + 6, y - 6);
        ctx.lineTo(x - 6, y + 6);
        ctx.stroke();
      };
      drawX(y1);
      drawX(y2);

      ctx.fillStyle = color;
      ctx.font = "bold 9px 'Chakra Petch', monospace";
      ctx.textAlign = "center";
      ctx.fillText("iS", x, Math.min(y1, y2) - 12);
    }
  }

  function hitTest(mx, my) {
    for (let s = 0; s < circuit.steps; s++) {
      for (let q = 0; q < circuit.numQubits; q++) {
        const cx = cellX(s);
        const cy = wireY(q);
        if (Math.abs(mx - cx) < CELL_W / 2 && Math.abs(my - cy) < CELL_H / 2) {
          return { step: s, qubit: q };
        }
      }
    }
    return null;
  }

  function findGateAt(step, qubit) {
    return circuit.gates.findIndex((g) => {
      if (g.step !== step) return false;
      if (SINGLE_QUBIT_GATES.includes(g.type)) return g.qubit === qubit;
      if (g.type === "CNOT" || g.type === "CZ")
        return g.control === qubit || g.target === qubit;
      if (g.type === "iSWAP")
        return g.qubit1 === qubit || g.qubit2 === qubit;
      return false;
    });
  }

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitTest(mx, my);
    if (!hit) {
      twoQubitPending = null;
      draw();
      return;
    }

    const existingIdx = findGateAt(hit.step, hit.qubit);

    if (TWO_QUBIT_GATES.includes(activeGate)) {
      if (twoQubitPending && twoQubitPending.step === hit.step && twoQubitPending.qubit !== hit.qubit) {
        circuit.gates = circuit.gates.filter(
          (g) => !(g.step === hit.step && (
            (SINGLE_QUBIT_GATES.includes(g.type) && (g.qubit === hit.qubit || g.qubit === twoQubitPending.qubit)) ||
            ((g.type === "CNOT" || g.type === "CZ") && (g.control === hit.qubit || g.target === hit.qubit || g.control === twoQubitPending.qubit || g.target === twoQubitPending.qubit)) ||
            (g.type === "iSWAP" && (g.qubit1 === hit.qubit || g.qubit2 === hit.qubit || g.qubit1 === twoQubitPending.qubit || g.qubit2 === twoQubitPending.qubit))
          ))
        );

        if (activeGate === "CNOT" || activeGate === "CZ") {
          circuit.gates.push({
            type: activeGate,
            control: twoQubitPending.qubit,
            target: hit.qubit,
            step: hit.step,
          });
        } else if (activeGate === "iSWAP") {
          circuit.gates.push({
            type: "iSWAP",
            qubit1: twoQubitPending.qubit,
            qubit2: hit.qubit,
            step: hit.step,
          });
        }
        twoQubitPending = null;
        draw();
        onChange();
      } else {
        twoQubitPending = { type: activeGate, qubit: hit.qubit, step: hit.step };
        draw();
      }
    } else {
      twoQubitPending = null;
      if (existingIdx >= 0) {
        circuit.gates.splice(existingIdx, 1);
      } else {
        circuit.gates.push({ type: activeGate, qubit: hit.qubit, step: hit.step });
      }
      draw();
      onChange();
    }
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const idx = findGateAt(hit.step, hit.qubit);
    if (idx >= 0) {
      circuit.gates.splice(idx, 1);
      draw();
      onChange();
    }
  });

  function setActiveGate(type) {
    activeGate = type;
    twoQubitPending = null;
  }

  function setPlayheadPosition(step) {
    playheadStep = step;
    draw();
  }

  function getCircuit() {
    return circuit;
  }

  function setSteps(n) {
    circuit.steps = n;
    draw();
    onChange();
  }

  function addSteps(n) {
    circuit.steps += n;
    draw();
  }

  function removeStep() {
    if (circuit.steps <= 1) return;
    circuit.steps--;
    circuit.gates = circuit.gates.filter((g) => g.step < circuit.steps);
    draw();
    onChange();
  }

  function addQubit() {
    if (circuit.numQubits >= 8) return;
    circuit.numQubits++;
    draw();
    onChange();
  }

  function removeQubit() {
    if (circuit.numQubits <= 1) return;
    const removed = circuit.numQubits - 1;
    circuit.numQubits--;
    // Remove gates that reference the removed qubit
    circuit.gates = circuit.gates.filter((g) => {
      if (SINGLE_QUBIT_GATES.includes(g.type)) return g.qubit < circuit.numQubits;
      if (g.type === "CNOT" || g.type === "CZ")
        return g.control < circuit.numQubits && g.target < circuit.numQubits;
      if (g.type === "iSWAP")
        return g.qubit1 < circuit.numQubits && g.qubit2 < circuit.numQubits;
      return true;
    });
    twoQubitPending = null;
    draw();
    onChange();
  }

  function loadCircuit(newCircuit) {
    circuit.steps = newCircuit.steps;
    circuit.numQubits = newCircuit.numQubits || 3;
    circuit.gates = newCircuit.gates.map((g) => ({ ...g }));
    twoQubitPending = null;
    draw();
    onChange();
  }

  function clear() {
    circuit.gates = [];
    twoQubitPending = null;
    draw();
    onChange();
  }

  draw();

  return { setActiveGate, setPlayheadPosition, getCircuit, setSteps, addSteps, removeStep, addQubit, removeQubit, loadCircuit, clear, draw };
}
