const CELL_W = 56;
const CELL_H = 56;
const WIRE_Y_START = 40;
const LABEL_W = 40;
const GATE_RADIUS = 18;

// All gates are single-cell. Controls are markers; non-control gates in the
// same step become controlled by all controls in that step.
const GATE_TYPES = ["H", "X", "Z", "T", "CTRL", "M"];
const TARGETABLE = ["H", "X", "Z", "T"]; // can be controlled

const GATE_COLORS = {
  H:    "#22d3ee",
  X:    "#ff6b6b",
  Z:    "#a855f7",
  T:    "#fbbf24",
  CTRL: "#94a3b8",
  M:    "#64748b",
};

export function createCircuitEditor(canvas, onChange) {
  const ctx = canvas.getContext("2d");
  let circuit = { steps: 12, numQubits: 3, gates: [] };
  let activeGate = "H";
  let playheadStep = -1;
  let dragging = null; // { gate, startX, startY, currentX, currentY, removed }
  let dropPreview = null; // { type, step, qubit }

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

    // Group gates by step for control connections
    const stepGroups = new Map();
    for (const gate of circuit.gates) {
      // Skip the gate currently being dragged so it doesn't render in place
      if (dragging && gate === dragging.gate) continue;
      if (!stepGroups.has(gate.step)) stepGroups.set(gate.step, []);
      stepGroups.get(gate.step).push(gate);
    }

    // Draw connection lines (controls → targets in the same step)
    for (const [step, gates] of stepGroups) {
      const controls = gates.filter((g) => g.type === "CTRL");
      const targets = gates.filter((g) => TARGETABLE.includes(g.type));
      if (controls.length > 0 && (targets.length > 0 || controls.length > 1)) {
        const allItems = [...controls, ...targets];
        const minQ = Math.min(...allItems.map((g) => g.qubit));
        const maxQ = Math.max(...allItems.map((g) => g.qubit));
        if (minQ !== maxQ) {
          const x = cellX(step);
          ctx.strokeStyle = "#94a3b8";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, wireY(minQ));
          ctx.lineTo(x, wireY(maxQ));
          ctx.stroke();
        }
      }
    }

    // Draw each gate
    for (const gate of circuit.gates) {
      if (dragging && gate === dragging.gate) continue;
      drawGate(gate);
    }

    // Drop preview (from palette drag-over)
    if (dropPreview) {
      const x = cellX(dropPreview.step);
      const y = wireY(dropPreview.qubit);
      ctx.globalAlpha = 0.4;
      drawGateAt(dropPreview.type, x, y);
      ctx.globalAlpha = 1;
    }

    // Dragging existing gate (ghost at cursor)
    if (dragging && dragging.currentX !== undefined) {
      ctx.globalAlpha = 0.7;
      drawGateAt(dragging.gate.type, dragging.currentX, dragging.currentY);
      ctx.globalAlpha = 1;
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
  }

  function drawGate(gate) {
    const x = cellX(gate.step);
    const y = wireY(gate.qubit);
    drawGateAt(gate.type, x, y);
  }

  function drawGateAt(type, x, y) {
    const color = GATE_COLORS[type] || "#fff";

    if (type === "CTRL") {
      // Control marker: filled dot with subtle ring
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    if (type === "M") {
      const r = GATE_RADIUS;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);
      ctx.beginPath();
      ctx.arc(x, y + 4, r * 0.55, Math.PI, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y + 4);
      ctx.lineTo(x + r * 0.35, y - r * 0.35);
      ctx.stroke();
      return;
    }

    // Single-qubit gate box (H, X, Z, T)
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
    ctx.fillText(type, x, y);
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
    return circuit.gates.findIndex(
      (g) => g.step === step && g.qubit === qubit
    );
  }

  function placeGate(type, step, qubit) {
    if (!GATE_TYPES.includes(type)) return;
    // Replace any existing gate at this cell
    const existing = findGateAt(step, qubit);
    if (existing >= 0) circuit.gates.splice(existing, 1);
    circuit.gates.push({ type, qubit, step });
    draw();
    onChange();
  }

  function removeGate(gate) {
    const idx = circuit.gates.indexOf(gate);
    if (idx >= 0) {
      circuit.gates.splice(idx, 1);
      draw();
      onChange();
    }
  }

  // ── Click to place (legacy) and right-click to remove ──────────────
  canvas.addEventListener("click", (e) => {
    if (dragging) return; // suppress click after drag
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const existing = findGateAt(hit.step, hit.qubit);
    if (existing < 0) {
      // Empty cell — place selected gate
      placeGate(activeGate, hit.step, hit.qubit);
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

  // ── HTML5 drag and drop from palette ───────────────────────────────
  canvas.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-harmoniq-gate")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    const type = window.__harmoniqDragType;
    if (hit && type) {
      dropPreview = { type, step: hit.step, qubit: hit.qubit };
      draw();
    }
  });

  canvas.addEventListener("dragleave", (e) => {
    // Only clear if leaving the canvas entirely
    const rect = canvas.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      dropPreview = null;
      draw();
    }
  });

  canvas.addEventListener("drop", (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("application/x-harmoniq-gate") || window.__harmoniqDragType;
    dropPreview = null;
    if (!type) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      placeGate(type, hit.step, hit.qubit);
    } else {
      draw();
    }
  });

  // ── Mouse drag to move/remove existing gates ───────────────────────
  let mouseDownGate = null;
  let mouseDownPos = null;

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitTest(mx, my);
    if (!hit) return;
    const idx = findGateAt(hit.step, hit.qubit);
    if (idx >= 0) {
      mouseDownGate = circuit.gates[idx];
      mouseDownPos = { x: e.clientX, y: e.clientY, mx, my };
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!mouseDownGate) return;
    const dx = e.clientX - mouseDownPos.x;
    const dy = e.clientY - mouseDownPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (!dragging && dist > 5) {
      dragging = { gate: mouseDownGate };
    }
    if (dragging) {
      const rect = canvas.getBoundingClientRect();
      dragging.currentX = e.clientX - rect.left;
      dragging.currentY = e.clientY - rect.top;
      draw();
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (!mouseDownGate) return;
    if (dragging) {
      const rect = canvas.getBoundingClientRect();
      const insideCanvas =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      if (insideCanvas) {
        const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit && (hit.step !== dragging.gate.step || hit.qubit !== dragging.gate.qubit)) {
          // Move: remove any existing gate at the destination, then update position
          const existing = findGateAt(hit.step, hit.qubit);
          if (existing >= 0) circuit.gates.splice(existing, 1);
          dragging.gate.step = hit.step;
          dragging.gate.qubit = hit.qubit;
          draw();
          onChange();
        } else {
          draw();
        }
      } else {
        // Dragged outside canvas — remove
        removeGate(dragging.gate);
      }
      // Suppress the upcoming click event
      setTimeout(() => { dragging = null; }, 0);
    } else {
      dragging = null;
    }
    mouseDownGate = null;
    mouseDownPos = null;
  });

  // ── Public API ─────────────────────────────────────────────────────
  function setActiveGate(type) {
    activeGate = type;
  }

  function setPlayheadPosition(step) {
    playheadStep = step;
    draw();
  }

  function getCircuit() {
    return circuit;
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
    circuit.numQubits--;
    circuit.gates = circuit.gates.filter((g) => g.qubit < circuit.numQubits);
    draw();
    onChange();
  }

  function loadCircuit(newCircuit) {
    circuit.steps = newCircuit.steps;
    circuit.numQubits = newCircuit.numQubits || 3;
    circuit.gates = newCircuit.gates.map((g) => ({ ...g }));
    draw();
    onChange();
  }

  function clear() {
    circuit.gates = [];
    draw();
    onChange();
  }

  draw();

  return {
    setActiveGate,
    setPlayheadPosition,
    getCircuit,
    addSteps,
    removeStep,
    addQubit,
    removeQubit,
    loadCircuit,
    clear,
    draw,
  };
}
