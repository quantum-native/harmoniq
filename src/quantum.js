import { QuantumPropertyManager, ensureLoaded, useQuantumForgeBuild } from "quantum-forge/quantum";

export async function initQuantum() {
  useQuantumForgeBuild("qubit");
  await ensureLoaded();
}

/**
 * Create a stateful quantum engine that keeps a single QuantumPropertyManager
 * alive. Properties are reused via the pool (measure → release → re-acquire)
 * rather than recreating the manager on each reset.
 */
export function createQuantumEngine() {
  const manager = new QuantumPropertyManager({ dimension: 2 });
  const m = manager.getModule();

  let qubits = [];
  let numQubits = 0;
  let cachedStep = -1;
  let circuitVersion = 0;

  /** Reset all properties to |0⟩ via measure + release + re-acquire. */
  function resetProperties(n) {
    // Release existing properties back to pool
    if (qubits.length > 0) {
      const values = m.measure_properties(qubits);
      for (let i = 0; i < qubits.length; i++) {
        manager.releaseProperty(qubits[i], values[i]);
      }
    }

    // Acquire the right number of fresh |0⟩ properties
    qubits = [];
    numQubits = n;
    for (let i = 0; i < n; i++) {
      qubits.push(manager.acquireProperty());
    }
    cachedStep = -1;
  }

  /** Call when the circuit is edited (gates/qubits changed). */
  function invalidate() {
    circuitVersion++;
  }

  /**
   * Evaluate the circuit up to the given step.
   * Advances incrementally on forward steps; resets on backward/loop/edit.
   */
  function evaluate(circuit, upToStep) {
    const n = circuit.numQubits || 3;

    // Mixed-state path: measurement gates require branching
    const measGates = circuit.gates
      .filter((g) => g.type === "M" && g.step <= upToStep)
      .sort((a, b) => a.step - b.step || a.qubit - b.qubit);

    if (measGates.length > 0) {
      return evaluateMixed(circuit, upToStep, n, measGates);
    }

    return evaluatePureCached(circuit, upToStep, n);
  }

  let lastCircuitVersion = -1;

  function evaluatePureCached(circuit, upToStep, n) {
    // Check if we can advance incrementally
    const needsReset =
      n !== numQubits ||
      lastCircuitVersion !== circuitVersion ||
      cachedStep > upToStep;

    if (needsReset) {
      resetProperties(n);
      lastCircuitVersion = circuitVersion;
    }

    // Apply gates from (cachedStep + 1) to upToStep
    for (let step = cachedStep + 1; step <= upToStep && step < circuit.steps; step++) {
      const gates = circuit.gates.filter((g) => g.step === step && g.type !== "M");
      for (const gate of gates) applyGate(m, qubits, gate);
    }
    cachedStep = upToStep;

    return readState(m, qubits, n);
  }

  function readState(mod, props, n) {
    const zRaw = mod.probabilities(props);
    const zBasis = parseProbabilities(zRaw, n);
    const stateVector = extractStateVector(mod, props, n);

    for (const q of props) mod.hadamard(q);
    const xRaw = mod.probabilities(props);
    const xBasis = parseProbabilities(xRaw, n);
    for (const q of props) mod.inverse_hadamard(q);

    const measures = computeMeasures(stateVector, zBasis, xBasis, n);
    return { zBasis, xBasis, stateVector, numQubits: n, measures, isMixed: false };
  }

  // --- Mixed-state evaluation (measurement gates) ---
  // Branches use the same manager: reset → replay → read → reset for next branch.

  function evaluateMixed(circuit, upToStep, n, measGates) {
    const numStates = 1 << n;
    const numBranches = 1 << measGates.length;
    let zBasis = new Array(numStates).fill(0);
    let xBasis = new Array(numStates).fill(0);
    let totalEntanglement = 0;
    const branches = [];

    for (let combo = 0; combo < numBranches; combo++) {
      const forced = measGates.map((mg, idx) => ({
        step: mg.step,
        qubit: mg.qubit,
        value: (combo >> (measGates.length - 1 - idx)) & 1,
      }));

      const result = evaluateBranch(circuit, upToStep, n, forced);
      if (!result) continue;

      for (let i = 0; i < numStates; i++) {
        zBasis[i] += result.weight * result.zBasis[i];
        xBasis[i] += result.weight * result.xBasis[i];
      }

      totalEntanglement += result.weight * branchEntanglement(result.sv, n);
      branches.push(result);
    }

    // Leave state reset for the next pure evaluation to pick up
    cachedStep = -1;
    lastCircuitVersion = -1;

    const measures = {
      entanglement: totalEntanglement,
      zCorrelation: basisCorrelation(zBasis, n),
      xCorrelation: basisCorrelation(xBasis, n),
    };

    return { zBasis, xBasis, stateVector: null, numQubits: n, measures, isMixed: true, branches };
  }

  function evaluateBranch(circuit, upToStep, n, forcedOutcomes) {
    const numStates = 1 << n;

    // Reset properties for this branch
    resetProperties(n);

    let weight = 1.0;
    let foIdx = 0;

    for (let step = 0; step <= upToStep && step < circuit.steps; step++) {
      const gates = circuit.gates.filter((g) => g.step === step && g.type !== "M");
      for (const gate of gates) applyGate(m, qubits, gate);

      while (foIdx < forcedOutcomes.length && forcedOutcomes[foIdx].step === step) {
        const fo = forcedOutcomes[foIdx];

        const probs = m.probabilities(qubits);
        const parsed = parseProbabilities(probs, n);
        const bit = 1 << (n - 1 - fo.qubit);
        let pVal = 0;
        for (let k = 0; k < numStates; k++) {
          if (fo.value === 1 ? (k & bit) : !(k & bit)) pVal += parsed[k];
        }
        weight *= pVal;
        if (weight < 1e-15) return null;

        m.forced_measure_properties([qubits[fo.qubit]], [fo.value]);
        foIdx++;
      }
    }

    const zRaw = m.probabilities(qubits);
    const zBasis = parseProbabilities(zRaw, n);
    const sv = extractStateVector(m, qubits, n);

    for (const q of qubits) m.hadamard(q);
    const xRaw = m.probabilities(qubits);
    const xBasis = parseProbabilities(xRaw, n);
    for (const q of qubits) m.inverse_hadamard(q);

    return { weight, zBasis, xBasis, sv };
  }

  return { evaluate, invalidate };
}

// --- Gate application ---

function applyGate(m, qubits, gate) {
  const q = (i) => qubits[i];
  switch (gate.type) {
    case "H":
      m.hadamard(q(gate.qubit));
      break;
    case "X":
      m.cycle(q(gate.qubit));
      break;
    case "Z":
      m.clock(q(gate.qubit));
      break;
    case "T":
      m.clock(q(gate.qubit), 0.25);
      break;
    case "CNOT":
      m.cycle(q(gate.target), 1, [q(gate.control).is(1)]);
      break;
    case "CZ":
      m.clock(q(gate.target), 1, [q(gate.control).is(1)]);
      break;
    case "iSWAP":
      m.i_swap(q(gate.qubit1), q(gate.qubit2), 1);
      break;
  }
}

// --- Probability / state vector helpers ---

function parseProbabilities(raw, n) {
  const numStates = 1 << n;
  const probs = new Array(numStates).fill(0);
  for (const entry of raw) {
    const index = valsToIndex(entry.qudit_values, n);
    probs[index] = entry.probability;
  }
  return probs;
}

function valsToIndex(vals, n) {
  let idx = 0;
  for (let i = 0; i < n; i++) {
    idx = (idx << 1) | vals[i];
  }
  return idx;
}

function extractStateVector(m, qubits, n) {
  const numStates = 1 << n;
  const dm = m.reduced_density_matrix(qubits);

  const rho = Array.from({ length: numStates }, () =>
    Array.from({ length: numStates }, () => ({ re: 0, im: 0 }))
  );
  for (const entry of dm) {
    const r = valsToIndex(entry.row_values, n);
    const c = valsToIndex(entry.col_values, n);
    rho[r][c] = { re: entry.value.real, im: entry.value.imag };
  }

  let refIdx = 0;
  let maxProb = 0;
  for (let i = 0; i < numStates; i++) {
    if (rho[i][i].re > maxProb) {
      maxProb = rho[i][i].re;
      refIdx = i;
    }
  }

  if (maxProb < 1e-12) {
    return Array.from({ length: numStates }, () => ({ re: 0, im: 0 }));
  }

  const alphaRef = Math.sqrt(maxProb);
  const sv = [];
  for (let i = 0; i < numStates; i++) {
    sv.push({
      re: rho[i][refIdx].re / alphaRef,
      im: rho[i][refIdx].im / alphaRef,
    });
  }
  return sv;
}

// --- Measures ---

function branchEntanglement(sv, n) {
  if (n < 2) return 0;
  const numStates = 1 << n;
  let totalEntropy = 0;

  for (let qi = 0; qi < n; qi++) {
    const bit = 1 << (n - 1 - qi);
    let r00re = 0, r11re = 0, r01re = 0, r01im = 0;

    for (let k = 0; k < numStates; k++) {
      const ak = sv[k];
      if ((k & bit) === 0) {
        const l = k | bit;
        const al = sv[l];
        r00re += ak.re * ak.re + ak.im * ak.im;
        r11re += al.re * al.re + al.im * al.im;
        r01re += ak.re * al.re + ak.im * al.im;
        r01im += ak.im * al.re - ak.re * al.im;
      }
    }

    const trace = r00re + r11re;
    const diff = r00re - r11re;
    const offDiagSq = r01re * r01re + r01im * r01im;
    const disc = Math.sqrt(diff * diff / 4 + offDiagSq);
    const l1 = (trace / 2) + disc;
    const l2 = (trace / 2) - disc;

    let s = 0;
    if (l1 > 1e-12) s -= l1 * Math.log2(l1);
    if (l2 > 1e-12) s -= l2 * Math.log2(l2);
    totalEntropy += s;
  }
  return totalEntropy / n;
}

function computeMeasures(sv, zBasis, xBasis, n) {
  if (n < 2) return { entanglement: 0, zCorrelation: 0, xCorrelation: 0 };
  return {
    entanglement: branchEntanglement(sv, n),
    zCorrelation: basisCorrelation(zBasis, n),
    xCorrelation: basisCorrelation(xBasis, n),
  };
}

function basisCorrelation(probs, n) {
  const numStates = 1 << n;
  let totalNMI = 0;
  let numPairs = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const bitI = 1 << (n - 1 - i);
      const bitJ = 1 << (n - 1 - j);

      let pI0 = 0, pI1 = 0, pJ0 = 0, pJ1 = 0;
      let p00 = 0, p01 = 0, p10 = 0, p11 = 0;

      for (let k = 0; k < numStates; k++) {
        const p = probs[k];
        const vi = (k & bitI) ? 1 : 0;
        const vj = (k & bitJ) ? 1 : 0;
        if (vi === 0) pI0 += p; else pI1 += p;
        if (vj === 0) pJ0 += p; else pJ1 += p;
        if (vi === 0 && vj === 0) p00 += p;
        else if (vi === 0 && vj === 1) p01 += p;
        else if (vi === 1 && vj === 0) p10 += p;
        else p11 += p;
      }

      const hI = shannonH([pI0, pI1]);
      const hJ = shannonH([pJ0, pJ1]);
      const hIJ = shannonH([p00, p01, p10, p11]);

      const mi = hI + hJ - hIJ;
      const minH = Math.min(hI, hJ);

      if (minH < 1e-12) {
        totalNMI += (hIJ < 1e-12) ? 1 : 0;
      } else {
        totalNMI += mi / minH;
      }
      numPairs++;
    }
  }
  return numPairs > 0 ? totalNMI / numPairs : 0;
}

function shannonH(probs) {
  let h = 0;
  for (const p of probs) {
    if (p > 1e-15) h -= p * Math.log2(p);
  }
  return h;
}
