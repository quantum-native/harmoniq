# harmoniq

**[Live demo](https://harmoniq.quantum.dev)**

A quantum synth that sonifies quantum states. Build quantum circuits and hear them play.

Harmoniq maps the probability distribution of an n-qubit quantum state to sound. A playhead scrubs through a circuit step by step, and at each step the state is evaluated in both the Z-basis and X-basis. Each basis state is assigned a note from a configurable scale, and its probability controls the volume of that note's oscillator.

## How it works

- **Circuit editor** -- place gates (H, X, Z, T, CNOT, CZ, iSWAP, M) on qubit wires
- **Two-basis sonification** -- Z-basis drives sine/square/saw/triangle oscillators; X-basis drives a separate layer one octave up by default
- **Measurement gate** -- collapses a qubit mid-circuit, creating a mixed state. The simulator branches into all possible outcomes weighted by probability
- **Live visualization** -- probability bar chart, real-time waveform oscilloscope, state vector display, entanglement and correlation meters

## Quantum simulation

All quantum simulation runs through [Quantum Forge](https://quantum.dev) via the [`quantum-forge`](https://www.npmjs.com/package/quantum-forge) npm package. There is no custom quantum math in this project -- harmoniq is a pure consumer of the public quantum forge API.

### Setup

- `ensureLoaded()` loads the quantum forge WASM binary
- `useQuantumForgeBuild("qubit")` selects the qubit-optimized variant (d2n20)
- The vite plugin serves WASM files during dev and copies them to `dist/` on build

### Per-step evaluation

Every time the playhead advances, harmoniq creates a fresh `QuantumPropertyManager` and replays the circuit from scratch:

1. `manager.acquireProperty()` allocates n qubit properties, each starting in |0⟩
2. Gates are applied via the WASM module (`manager.getModule()`):
   - `m.hadamard(prop)` -- H gate
   - `m.cycle(prop)` -- X gate
   - `m.clock(prop)` / `m.clock(prop, 0.25)` -- Z and T gates
   - `m.cycle(target, 1, [control.is(1)])` -- CNOT (predicated X)
   - `m.clock(target, 1, [control.is(1)])` -- CZ (predicated Z)
   - `m.i_swap(p1, p2, 1)` -- iSWAP
3. `m.probabilities(qubits)` reads the Z-basis probability distribution without collapsing the state
4. Hadamard is applied to all qubits, probabilities are read again (X-basis), then undone with `m.inverse_hadamard()`
5. `m.reduced_density_matrix(qubits)` extracts the full density matrix, from which harmoniq reconstructs the state vector
6. `m.forced_measure_properties([prop], [value])` handles measurement gates by forcing specific outcomes to simulate branching into a mixed state

## Development

```
npm install --legacy-peer-deps
npm run dev
```

The `--legacy-peer-deps` flag is needed because the quantum forge package declares a vite peer dependency that hasn't been updated for Vite 8 yet.

## Deployment

Tagged releases (`v*`) trigger a GitHub Actions workflow that builds and deploys to Cloudflare Pages via wrangler.

```
git tag v0.1.0
git push origin v0.1.0
```

Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets.
