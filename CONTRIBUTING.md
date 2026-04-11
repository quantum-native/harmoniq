# Contributing to harmoniq

Thanks for your interest in contributing. harmoniq is a small project and contributions are welcome.

## Before you start

For anything beyond a trivial fix (typo, obvious bug), please **open an issue first** so we can agree on the approach before you spend time on a PR. This avoids wasted work on changes that don't fit the direction of the project.

Good things to open issues for:

- Bugs you've hit (include steps to reproduce and browser/OS)
- New gates, scales, or sonification ideas
- UX or layout problems
- Questions about how the code works

## Development setup

```
npm install
npm run dev
```

That's it — `vite` serves the app at `http://localhost:5173` and the Quantum Forge WASM binary is loaded by the dev plugin. No build step or extra tooling is needed to iterate.

To produce a production bundle:

```
npm run build
```

## Code layout

- `index.html` — page shell, styles, and UI markup
- `src/main.js` — app entry and wiring
- `src/circuit.js` — drag-and-drop circuit editor
- `src/quantum.js` — Quantum Forge integration and per-step evaluation
- `src/audio.js` — Web Audio oscillator layer driven by probabilities

All quantum math lives in [`quantum-forge`](https://www.npmjs.com/package/quantum-forge). harmoniq is a pure consumer of that API — please don't reimplement gates or state math here. If you need a primitive that Quantum Forge doesn't expose, open an issue on the harmoniq repo and we'll figure out the right place for it.

## Pull requests

- Branch from `main` and open your PR against `main`. Direct pushes to `main` are disabled; everything lands via PR after CI passes.
- Keep PRs focused. One logical change per PR is much easier to review than a grab-bag.
- Match the existing code style. No formatter is enforced, but the existing code is plain ES modules, 2-space indent, no semicolons omitted, and minimal external dependencies — please stay consistent.
- Before pushing, run `npm run build` and make sure the app still loads and plays in `npm run dev`. There is no automated test suite yet, so manual verification matters.
- Write a clear commit message explaining the *why*, not just the *what*. Commit history is part of the documentation.

Reviews come from [@cantwellc](https://github.com/cantwellc) (see `.github/CODEOWNERS`).

## Reporting security issues

Please do not open public issues for security-sensitive reports. Email the maintainer directly instead.
