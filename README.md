# harmoniq

**[Live demo](https://harmoniq.quantum.dev)**

A quantum synth that sonifies quantum states. Build quantum circuits and hear them play.

Harmoniq maps the probability distribution of an n-qubit quantum state to sound. A playhead scrubs through a circuit step by step, and at each step the state is evaluated in both the Z-basis and X-basis. Each basis state is assigned a note from a configurable scale, and its probability controls the volume of that note's oscillator.

## How it works

- **Drag-and-drop circuit editor** -- place gates (H, X, Z, T, control, M) on qubit wires; drop a control (●) in the same step as another gate to make it controlled (●+X = CNOT, ●+●+X = Toffoli, etc.)
- **Two-basis sonification** -- Z-basis drives sine/square/saw/triangle oscillators; X-basis drives a separate layer one octave up by default
- **Measurement gate** -- collapses a qubit mid-circuit
- **Live visualization** -- probability bar chart, real-time waveform oscilloscope, state vector display, entanglement and correlation meters

## Quantum simulation

All quantum simulation runs through [Quantum Forge](https://quantum.dev) via the [`quantum-forge`](https://www.npmjs.com/package/quantum-forge) npm package. There is no custom quantum math in this project -- harmoniq is a pure consumer of the public quantum forge API.

### Setup

- `ensureLoaded()` loads the quantum forge WASM binary
- `useQuantumForgeBuild("qubit")` selects the qubit-optimized variant (d2n20)
- The vite plugin serves WASM files during dev and copies them to `dist/` on build

### Per-step evaluation

A single `QuantumPropertyManager` lives for the lifetime of the engine. As the playhead advances, the engine applies new gates incrementally; on loop, qubit reset, or circuit edit, properties are released back to the pool (which resets them to |0⟩) and re-acquired.

1. `manager.acquireProperty()` allocates n qubit properties, each starting in |0⟩
2. For each circuit step, gates are batched and applied via the WASM module (`manager.getModule()`). Controls in the same step become predicates for every non-control gate at that step:
   - `m.hadamard(prop, 1, predicates)` -- H (controlled if predicates present)
   - `m.cycle(prop, 1, predicates)` -- X
   - `m.clock(prop, 1, predicates)` -- Z
   - `m.clock(prop, 0.25, predicates)` -- T (π/8 phase)
3. `m.probabilities(qubits)` reads the Z-basis probability distribution without collapsing the state
4. Hadamard is applied to all qubits, probabilities are read again (X-basis), then undone with `m.inverse_hadamard()`
5. `m.reduced_density_matrix(qubits)` extracts the full density matrix, from which harmoniq reconstructs the state vector
6. `m.forced_measure_properties([prop], [value])` handles measurement gates by forcing specific outcomes to simulate branching into a mixed state

## Development

```
npm install
npm run dev
```

## Contributing

Contributions are welcome via pull request. Please open an issue first for anything substantial so we can discuss the approach.
