// What harmoniq lends Sutradhar's dev desk when the page runs in its frame
// (/__helm/desk/harmoniq on the board). Dev only: main.ts imports this behind
// import.meta.env.DEV, so production builds drop it.
//
// The circuit lives on a canvas, so the desk's page text cannot see it. The
// "circuit" provider sends it, with the transport and the instrument settings.
// A hand-built circuit has no save, and a full reload clears it, so while one
// is on screen the desk holds its reloads until Chris presses Apply.

import type { Circuit, Gate, GateKind } from "../circuit.js";

/** window.__SUTRA_DESK__, the part of it this file uses. */
interface SutraDesk {
  provide(name: string, fn: (() => unknown) | null): void;
  hold(reason: string | null): void;
}

export interface DeskDeps {
  circuit(): Circuit;
  presets: Readonly<Record<string, Circuit>>;
  transport(): { playing: boolean; step: number; stepsPerSecond: number };
  sound(): unknown;
}

const SYMBOL: Record<GateKind, string> = { H: "H", X: "X", Z: "Z", T: "T", CTRL: "●", M: "M" };
const MAX_STEPS_SHOWN = 64;
const MAX_GATES_LISTED = 256;

function gateKey(g: Gate): string {
  return `${g.type}@q${g.qubit}s${g.step}`;
}

function sameCircuit(a: Circuit, b: Circuit): boolean {
  if (a.steps !== b.steps || a.numQubits !== b.numQubits || a.gates.length !== b.gates.length) return false;
  const keys = new Set(a.gates.map(gateKey));
  return b.gates.every((g) => keys.has(gateKey(g)));
}

/** "empty", the preset the circuit matches exactly, or "custom". */
export function circuitSource(circuit: Circuit, presets: Readonly<Record<string, Circuit>>): string {
  if (circuit.gates.length === 0) return "empty";
  for (const [name, preset] of Object.entries(presets)) {
    if (sameCircuit(circuit, preset)) return `preset:${name}`;
  }
  return "custom";
}

/** One row per qubit, one column per step: H X Z T, ● for a control, M, · for none. */
export function circuitGrid(circuit: Circuit): string[] {
  const shown = Math.min(circuit.steps, MAX_STEPS_SHOWN);
  const rows = Array.from({ length: circuit.numQubits }, () => Array<string>(shown).fill("·"));
  for (const g of circuit.gates) {
    const row = rows[g.qubit];
    if (row && g.step < shown) row[g.step] = SYMBOL[g.type];
  }
  return rows.map((row, q) => `q${q} ${row.join(" ")}`);
}

/** The "circuit" context: what is built, where the playhead is, how it sounds. */
export function circuitContext(deps: DeskDeps): Record<string, unknown> {
  const circuit = deps.circuit();
  const transport = deps.transport();
  return {
    source: circuitSource(circuit, deps.presets),
    numQubits: circuit.numQubits,
    steps: circuit.steps,
    gateCount: circuit.gates.length,
    grid: circuitGrid(circuit),
    gridTruncated: circuit.steps > MAX_STEPS_SHOWN,
    gates: circuit.gates.slice(0, MAX_GATES_LISTED).map(gateKey),
    playing: transport.playing,
    playheadStep: transport.playing ? transport.step : null,
    stepsPerSecond: transport.stepsPerSecond,
    instrument: deps.sound(),
  };
}

function frameDesk(): SutraDesk | null {
  if (window.parent === window || window.parent !== window.top) return null;
  const desk = (window as { __SUTRA_DESK__?: unknown }).__SUTRA_DESK__ as Partial<SutraDesk> | null | undefined;
  return desk && typeof desk.provide === "function" && typeof desk.hold === "function" ? (desk as SutraDesk) : null;
}

export function mountSutraDesk(deps: DeskDeps): void {
  const desk = frameDesk();
  if (!desk) return;

  desk.provide("circuit", () => {
    try {
      return circuitContext(deps);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Every circuit change starts from user input, so check after each one
  // rather than reaching into the editor's change callback.
  let held = false;
  const syncHold = () => {
    let custom = false;
    try {
      custom = circuitSource(deps.circuit(), deps.presets) === "custom";
    } catch {
      return;
    }
    if (custom === held) return;
    held = custom;
    desk.hold(custom ? "a hand-built circuit is on screen, and a reload clears it" : null);
  };
  const later = () => setTimeout(syncHold, 0);
  for (const type of ["click", "pointerup", "contextmenu", "drop", "keyup", "change"]) {
    document.addEventListener(type, later, true);
  }
  syncHold();
}
