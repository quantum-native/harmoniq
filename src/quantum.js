import { QuantumPropertyManager, ensureLoaded } from "quantum-forge/quantum";

export async function initQuantum() {
  // The default WASM build (d3n12) supports dimension 2 (qubits).
  // When the qubit variant (d2n20) ships in the npm package,
  // add: useQuantumForgeBuild("qubit") here for a smaller binary.
  await ensureLoaded();
}

/**
 * Evaluate a circuit up to a given step.
 * If there are measurement gates, branches into all possible outcomes
 * to produce a proper mixed-state probability distribution.
 */
export function evaluateCircuit(circuit, upToStep) {
  const n = circuit.numQubits || 3;
  const numStates = 1 << n;

  // Find measurement gates up to current step, sorted by step
  const measGates = circuit.gates
    .filter((g) => g.type === "M" && g.step <= upToStep)
    .sort((a, b) => a.step - b.step || a.qubit - b.qubit);

  if (measGates.length === 0) {
    return evaluatePure(circuit, upToStep, n);
  }

  // Mixed-state path: enumerate all outcome combinations
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

  const measures = {
    entanglement: totalEntanglement,
    zCorrelation: basisCorrelation(zBasis, n),
    xCorrelation: basisCorrelation(xBasis, n),
  };

  return { zBasis, xBasis, stateVector: null, numQubits: n, measures, isMixed: true, branches };
}

/** Pure-state evaluation (no measurement gates). */
function evaluatePure(circuit, upToStep, n) {
  const numStates = 1 << n;
  const manager = new QuantumPropertyManager({ dimension: 2 });
  const m = manager.getModule();

  const qubits = [];
  for (let i = 0; i < n; i++) qubits.push(manager.acquireProperty());

  for (let step = 0; step <= upToStep && step < circuit.steps; step++) {
    const gates = circuit.gates.filter((g) => g.step === step && g.type !== "M");
    for (const gate of gates) applyGate(m, qubits, gate);
  }

  const zRaw = m.probabilities(qubits);
  const zBasis = parseProbabilities(zRaw, n);
  const stateVector = extractStateVector(m, qubits, n);

  for (const q of qubits) m.hadamard(q);
  const xRaw = m.probabilities(qubits);
  const xBasis = parseProbabilities(xRaw, n);
  for (const q of qubits) m.inverse_hadamard(q);

  const measures = computeMeasures(stateVector, zBasis, xBasis, n);

  return { zBasis, xBasis, stateVector, numQubits: n, measures, isMixed: false };
}

/**
 * Evaluate a single branch with specific forced measurement outcomes.
 * Returns { weight, zBasis, xBasis, sv } or null if branch has zero probability.
 */
function evaluateBranch(circuit, upToStep, n, forcedOutcomes) {
  const numStates = 1 << n;
  const manager = new QuantumPropertyManager({ dimension: 2 });
  const m = manager.getModule();

  const qubits = [];
  for (let i = 0; i < n; i++) qubits.push(manager.acquireProperty());

  let weight = 1.0;
  let foIdx = 0;

  for (let step = 0; step <= upToStep && step < circuit.steps; step++) {
    // Apply unitary gates first
    const gates = circuit.gates.filter((g) => g.step === step && g.type !== "M");
    for (const gate of gates) applyGate(m, qubits, gate);

    // Process forced measurements at this step
    while (foIdx < forcedOutcomes.length && forcedOutcomes[foIdx].step === step) {
      const fo = forcedOutcomes[foIdx];

      // Probability of this outcome
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

/** Entanglement for a pure-state branch (avg single-qubit von Neumann entropy). */
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

/** Measures for a pure state (used when no measurement gates). */
function computeMeasures(sv, zBasis, xBasis, n) {
  if (n < 2) return { entanglement: 0, zCorrelation: 0, xCorrelation: 0 };
  return {
    entanglement: branchEntanglement(sv, n),
    zCorrelation: basisCorrelation(zBasis, n),
    xCorrelation: basisCorrelation(xBasis, n),
  };
}

/**
 * Average pairwise normalized mutual information in a given basis.
 * I(A;B) = H(A) + H(B) - H(A,B), normalized by min(H(A), H(B)).
 *
 * Unlike Pearson correlation, this correctly handles deterministic states:
 * |00⟩ has NMI = 1 in Z-basis (knowing q0 fully determines q1) because
 * H(A) = H(B) = H(A,B) = 0, and we define 0/0 = 1 when the joint entropy
 * is also 0 (perfect agreement with no uncertainty).
 */
function basisCorrelation(probs, n) {
  const numStates = 1 << n;
  let totalNMI = 0;
  let numPairs = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const bitI = 1 << (n - 1 - i);
      const bitJ = 1 << (n - 1 - j);

      // Marginal probabilities
      let pI0 = 0, pI1 = 0, pJ0 = 0, pJ1 = 0;
      // Joint probabilities: [i=0,j=0], [i=0,j=1], [i=1,j=0], [i=1,j=1]
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

      const mi = hI + hJ - hIJ; // mutual information
      const minH = Math.min(hI, hJ);

      if (minH < 1e-12) {
        // Both marginals have ~zero entropy: outcomes are deterministic.
        // If joint entropy is also ~zero, outcomes always agree → NMI = 1.
        // If one marginal has entropy but the other doesn't, NMI = 0.
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
