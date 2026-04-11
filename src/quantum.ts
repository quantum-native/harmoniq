import {
  QuantumPropertyManager,
  ensureLoaded,
  useQuantumForgeBuild,
} from "quantum-forge/quantum";

// `QuantumProperty` is declared inside quantum-forge's .d.ts but not part of
// the public export list. Recover the type via `acquireProperty`'s return.
type QuantumProperty = ReturnType<QuantumPropertyManager["acquireProperty"]>;

// --- Domain types ---

/** A single complex amplitude in the reconstructed state vector. */
export interface Complex {
  re: number;
  im: number;
}

/** A gate placement on the circuit grid. */
export interface Gate {
  type: string;
  qubit: number;
  step: number;
}

/** Circuit shape consumed by `QuantumEngine.evaluate`. */
export interface Circuit {
  steps: number;
  numQubits: number;
  gates: Gate[];
}

/** Aggregate measures derived from a single evaluation. */
export interface Measures {
  entanglement: number;
  zCorrelation: number;
  xCorrelation: number;
}

/** A single mixed-state branch produced by measurement gates. */
export interface MixedBranch {
  weight: number;
  zBasis: number[];
  xBasis: number[];
  sv: Complex[];
}

/**
 * Result of evaluating the circuit at a particular step. The shape is a
 * discriminated union on `isMixed`: pure states have a `stateVector`, mixed
 * states have a `branches` array and a `null` state vector.
 */
export type EvaluationResult =
  | {
      zBasis: number[];
      xBasis: number[];
      stateVector: Complex[];
      numQubits: number;
      measures: Measures;
      isMixed: false;
    }
  | {
      zBasis: number[];
      xBasis: number[];
      stateVector: null;
      numQubits: number;
      measures: Measures;
      isMixed: true;
      branches: MixedBranch[];
    };

/** Public surface of the stateful quantum engine. */
export interface QuantumEngine {
  /** Evaluate the circuit up to (and including) `upToStep`. */
  evaluate(circuit: Circuit, upToStep: number): EvaluationResult;
  /** Mark the cached state stale (call when the circuit is edited). */
  invalidate(): void;
}

// Module type returned by manager.getModule(). We pin it here so the
// inner helpers can be typed without re-deriving the namespace.
type QFModule = ReturnType<QuantumPropertyManager["getModule"]>;

// Forced-outcome record used during mixed-state branch evaluation.
interface ForcedOutcome {
  step: number;
  qubit: number;
  value: number;
}

// Internal per-branch result before mixing.
interface BranchResult {
  weight: number;
  zBasis: number[];
  xBasis: number[];
  sv: Complex[];
}

export async function initQuantum(): Promise<void> {
  useQuantumForgeBuild("qubit");
  await ensureLoaded();
}

/**
 * Create a stateful quantum engine that keeps a single QuantumPropertyManager
 * alive. Properties are reused via the pool (measure → release → re-acquire)
 * rather than recreating the manager on each reset.
 */
export function createQuantumEngine(): QuantumEngine {
  const manager = new QuantumPropertyManager({ dimension: 2 });
  const m = manager.getModule();

  let qubits: QuantumProperty[] = [];
  let numQubits = 0;
  let cachedStep = -1;
  let circuitVersion = 0;

  /** Reset all properties to |0⟩ via measure + release + re-acquire. */
  function resetProperties(n: number): void {
    // Release existing properties back to pool
    if (qubits.length > 0) {
      const values = m.measure_properties(qubits);
      for (let i = 0; i < qubits.length; i++) {
        const q = qubits[i];
        const v = values[i];
        if (q === undefined || v === undefined) continue;
        manager.releaseProperty(q, v);
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
  function invalidate(): void {
    circuitVersion++;
  }

  /**
   * Evaluate the circuit up to the given step.
   * Advances incrementally on forward steps; resets on backward/loop/edit.
   */
  function evaluate(circuit: Circuit, upToStep: number): EvaluationResult {
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

  function evaluatePureCached(
    circuit: Circuit,
    upToStep: number,
    n: number,
  ): EvaluationResult {
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
      const stepGates = circuit.gates.filter((g) => g.step === step && g.type !== "M");
      applyStep(m, qubits, stepGates);
    }
    cachedStep = upToStep;

    return readState(m, qubits, n);
  }

  function readState(
    mod: QFModule,
    props: QuantumProperty[],
    n: number,
  ): EvaluationResult {
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

  function evaluateMixed(
    circuit: Circuit,
    upToStep: number,
    n: number,
    measGates: Gate[],
  ): EvaluationResult {
    const numStates = 1 << n;
    const numBranches = 1 << measGates.length;
    const zBasis: number[] = new Array(numStates).fill(0);
    const xBasis: number[] = new Array(numStates).fill(0);
    let totalEntanglement = 0;
    const branches: MixedBranch[] = [];

    for (let combo = 0; combo < numBranches; combo++) {
      const forced: ForcedOutcome[] = measGates.map((mg, idx) => ({
        step: mg.step,
        qubit: mg.qubit,
        value: (combo >> (measGates.length - 1 - idx)) & 1,
      }));

      const result = evaluateBranch(circuit, upToStep, n, forced);
      if (!result) continue;

      for (let i = 0; i < numStates; i++) {
        const zi = result.zBasis[i] ?? 0;
        const xi = result.xBasis[i] ?? 0;
        zBasis[i] = (zBasis[i] ?? 0) + result.weight * zi;
        xBasis[i] = (xBasis[i] ?? 0) + result.weight * xi;
      }

      totalEntanglement += result.weight * branchEntanglement(result.sv, n);
      branches.push(result);
    }

    // Leave state reset for the next pure evaluation to pick up
    cachedStep = -1;
    lastCircuitVersion = -1;

    const measures: Measures = {
      entanglement: totalEntanglement,
      zCorrelation: basisCorrelation(zBasis, n),
      xCorrelation: basisCorrelation(xBasis, n),
    };

    return {
      zBasis,
      xBasis,
      stateVector: null,
      numQubits: n,
      measures,
      isMixed: true,
      branches,
    };
  }

  function evaluateBranch(
    circuit: Circuit,
    upToStep: number,
    n: number,
    forcedOutcomes: ForcedOutcome[],
  ): BranchResult | null {
    const numStates = 1 << n;

    // Reset properties for this branch
    resetProperties(n);

    let weight = 1.0;
    let foIdx = 0;

    for (let step = 0; step <= upToStep && step < circuit.steps; step++) {
      const stepGates = circuit.gates.filter((g) => g.step === step && g.type !== "M");
      applyStep(m, qubits, stepGates);

      while (foIdx < forcedOutcomes.length && forcedOutcomes[foIdx]?.step === step) {
        const fo = forcedOutcomes[foIdx];
        if (fo === undefined) break;

        const probs = m.probabilities(qubits);
        const parsed = parseProbabilities(probs, n);
        const bit = 1 << (n - 1 - fo.qubit);
        let pVal = 0;
        for (let k = 0; k < numStates; k++) {
          if (fo.value === 1 ? (k & bit) : !(k & bit)) pVal += parsed[k] ?? 0;
        }
        weight *= pVal;
        if (weight < 1e-15) return null;

        const target = qubits[fo.qubit];
        if (target === undefined) {
          throw new Error(`Forced measurement targets missing qubit ${fo.qubit}`);
        }
        m.forced_measure_properties([target], [fo.value]);
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

/**
 * Apply all gates at one circuit step. Controls in the step become predicates
 * for every non-control gate at the same step. So:
 *   CTRL(q0) + X(q1)            → CNOT (q0 controls q1)
 *   CTRL(q0) + Z(q1)            → CZ
 *   CTRL(q0) + CTRL(q1) + X(q2) → Toffoli
 */
function applyStep(m: QFModule, qubits: QuantumProperty[], gates: Gate[]): void {
  const controls = gates.filter((g) => g.type === "CTRL");
  const predicates = controls.map((c) => {
    const q = qubits[c.qubit];
    if (q === undefined) {
      throw new Error(`Control references missing qubit ${c.qubit}`);
    }
    return q.is(1);
  });
  const useArg = predicates.length > 0 ? predicates : undefined;

  for (const gate of gates) {
    if (gate.type === "CTRL") continue;
    const q = qubits[gate.qubit];
    if (q === undefined) continue;
    switch (gate.type) {
      case "H":
        m.hadamard(q, 1, useArg);
        break;
      case "X":
        m.cycle(q, 1, useArg);
        break;
      case "Z":
        m.clock(q, 1, useArg);
        break;
      case "T":
        m.clock(q, 0.25, useArg);
        break;
    }
  }
}

// --- Probability / state vector helpers ---

function parseProbabilities(
  raw: Array<{ probability: number; qudit_values: number[] }>,
  n: number,
): number[] {
  const numStates = 1 << n;
  const probs: number[] = new Array(numStates).fill(0);
  for (const entry of raw) {
    const index = valsToIndex(entry.qudit_values, n);
    probs[index] = entry.probability;
  }
  return probs;
}

function valsToIndex(vals: number[], n: number): number {
  let idx = 0;
  for (let i = 0; i < n; i++) {
    idx = (idx << 1) | (vals[i] ?? 0);
  }
  return idx;
}

function extractStateVector(
  m: QFModule,
  qubits: QuantumProperty[],
  n: number,
): Complex[] {
  const numStates = 1 << n;
  const dm = m.reduced_density_matrix(qubits);

  const rho: Complex[][] = Array.from({ length: numStates }, () =>
    Array.from({ length: numStates }, () => ({ re: 0, im: 0 })),
  );
  for (const entry of dm) {
    const r = valsToIndex(entry.row_values, n);
    const c = valsToIndex(entry.col_values, n);
    const row = rho[r];
    if (row === undefined) continue;
    row[c] = { re: entry.value.real, im: entry.value.imag };
  }

  let refIdx = 0;
  let maxProb = 0;
  for (let i = 0; i < numStates; i++) {
    const diag = rho[i]?.[i];
    if (diag !== undefined && diag.re > maxProb) {
      maxProb = diag.re;
      refIdx = i;
    }
  }

  if (maxProb < 1e-12) {
    return Array.from({ length: numStates }, () => ({ re: 0, im: 0 }));
  }

  const alphaRef = Math.sqrt(maxProb);
  const sv: Complex[] = [];
  for (let i = 0; i < numStates; i++) {
    const cell = rho[i]?.[refIdx] ?? { re: 0, im: 0 };
    sv.push({
      re: cell.re / alphaRef,
      im: cell.im / alphaRef,
    });
  }
  return sv;
}

// --- Measures ---

function branchEntanglement(sv: Complex[], n: number): number {
  if (n < 2) return 0;
  const numStates = 1 << n;
  let totalEntropy = 0;

  for (let qi = 0; qi < n; qi++) {
    const bit = 1 << (n - 1 - qi);
    let r00re = 0, r11re = 0, r01re = 0, r01im = 0;

    for (let k = 0; k < numStates; k++) {
      const ak = sv[k];
      if (ak === undefined) continue;
      if ((k & bit) === 0) {
        const l = k | bit;
        const al = sv[l];
        if (al === undefined) continue;
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

function computeMeasures(
  sv: Complex[],
  zBasis: number[],
  xBasis: number[],
  n: number,
): Measures {
  if (n < 2) return { entanglement: 0, zCorrelation: 0, xCorrelation: 0 };
  return {
    entanglement: branchEntanglement(sv, n),
    zCorrelation: basisCorrelation(zBasis, n),
    xCorrelation: basisCorrelation(xBasis, n),
  };
}

function basisCorrelation(probs: number[], n: number): number {
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
        const p = probs[k] ?? 0;
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

function shannonH(probs: number[]): number {
  let h = 0;
  for (const p of probs) {
    if (p > 1e-15) h -= p * Math.log2(p);
  }
  return h;
}
