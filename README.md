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

All quantum simulation runs through [Quantum Forge](https://quantum.dev) via the [`quantum-forge`](https://www.npmjs.com/package/quantum-forge) npm package. Gate operations, probability queries, and density matrix reads are delegated to the Quantum Forge WASM backend -- there is no custom quantum math in this project.

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
