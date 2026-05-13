/**
 * A small interactive Bloch sphere HUD. Renders into a caller-owned canvas
 * and reports back rotations via `onChange`. Built for the channel cards
 * but has no dependency on the channels store.
 */

export interface BlochHUDOptions {
  /** Accent color for the Bloch vector arrow. */
  color: string;
  /** Initial polar angle from +z, in radians. */
  initialTheta: number;
  /** Initial azimuth from +x toward +y, in radians. */
  initialPhi: number;
  /** Dynamic predicate: when true, drag/click updates snap to multiples of π/8. */
  isSnapping: () => boolean;
  /** Called after every change. Callers persist this back to wherever owns the truth. */
  onChange: (theta: number, phi: number) => void;
}

export interface BlochHUD {
  /** Programmatically set the vector. Doesn't fire onChange. */
  setVector(theta: number, phi: number): void;
  /** Recolor the vector arrow (channel color may change). */
  setColor(color: string): void;
  /** Force a redraw (call after the canvas is resized externally). */
  redraw(): void;
  destroy(): void;
}

interface Vec3 { x: number; y: number; z: number; }
interface Vec2 { x: number; y: number; }

// View matrix: camera at azimuth 30°, elevation 20° above the equator,
// looking at the origin. Picked so the equator projects to a clean
// horizontally-aligned flat ellipse on screen and +z stays vertical.
const AZ = (30 * Math.PI) / 180;
const EL = (20 * Math.PI) / 180;
const cAZ = Math.cos(AZ), sAZ = Math.sin(AZ);
const cEL = Math.cos(EL), sEL = Math.sin(EL);

function project(v: Vec3): Vec2 {
  const xc = cAZ * v.x + sAZ * v.y;
  const yc = -sAZ * v.x + cAZ * v.y;
  const zc = v.z;
  // Combined elevation + canvas-down sign flip on the vertical axis.
  return { x: xc, y: -(yc * sEL + zc * cEL) };
}

const SNAP_STEP = Math.PI / 8;

// Hardcoded screen-relative offsets (in units of sphere radius) for the
// six axis-pole labels. Projecting the unit axes through `project` puts a
// few of them inside the silhouette of the sphere, so we lay them out by
// hand around the projected sphere instead.
interface PoleSpec { text: string; dx: number; dy: number; theta: number; phi: number; }
const POLES: PoleSpec[] = [
  { text: "+X", dx:  1.25, dy:  0.25, theta: Math.PI / 2, phi: 0 },
  { text: "−X", dx: -1.25, dy: -0.25, theta: Math.PI / 2, phi: Math.PI },
  { text: "+Y", dx:  0.75, dy: -0.55, theta: Math.PI / 2, phi: Math.PI / 2 },
  { text: "−Y", dx: -0.75, dy:  0.55, theta: Math.PI / 2, phi: (3 * Math.PI) / 2 },
  { text: "+Z", dx:  0.0,  dy: -1.20, theta: 0,            phi: 0 },
  { text: "−Z", dx:  0.0,  dy:  1.20, theta: Math.PI,      phi: 0 },
];

export function createBlochHUD(
  canvas: HTMLCanvasElement,
  opts: BlochHUDOptions,
): BlochHUD {
  const ctx: CanvasRenderingContext2D = (() => {
    const c = canvas.getContext("2d");
    if (!c) throw new Error("bloch: 2D canvas context unavailable");
    return c;
  })();

  let theta = clampTheta(opts.initialTheta);
  let phi = wrapPhi(opts.initialPhi);
  let color = opts.color;
  let dragging = false;
  let dragMovedDistance = 0; // suppress label-click after a real drag
  let lastX = 0;
  let lastY = 0;

  function clampTheta(t: number): number {
    return Math.max(0, Math.min(Math.PI, t));
  }
  function wrapPhi(p: number): number {
    let v = p % (2 * Math.PI);
    if (v < 0) v += 2 * Math.PI;
    return v;
  }
  function maybeSnap(t: number, p: number): [number, number] {
    if (!opts.isSnapping()) return [t, p];
    return [Math.round(t / SNAP_STEP) * SNAP_STEP, Math.round(p / SNAP_STEP) * SNAP_STEP];
  }

  function blochVec(t: number, p: number): Vec3 {
    const s = Math.sin(t);
    return { x: s * Math.cos(p), y: s * Math.sin(p), z: Math.cos(t) };
  }

  function getLayout() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 160;
    const r = Math.min(w, h) * 0.36;
    return { w, h, r, cx: w / 2, cy: h / 2 };
  }

  function poleScreenPos(p: PoleSpec, cx: number, cy: number, r: number): Vec2 {
    return { x: cx + p.dx * r, y: cy + p.dy * r };
  }

  function setSize() {
    const dpr = devicePixelRatio;
    const { w, h } = getLayout();
    if (canvas.width !== w * dpr) canvas.width = w * dpr;
    if (canvas.height !== h * dpr) canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    setSize();
    const { w, h, r, cx, cy } = getLayout();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0c1018";
    ctx.fillRect(0, 0, w, h);

    // Sphere silhouette (the outline of a sphere is always a circle)
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Equator (z = 0 plane) and prime meridian (y = 0 plane)
    drawGreatCircle(cx, cy, r, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    drawGreatCircle(cx, cy, r, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

    // Axis lines through origin
    drawAxis(cx, cy, r, { x: 1, y: 0, z: 0 });
    drawAxis(cx, cy, r, { x: 0, y: 1, z: 0 });
    drawAxis(cx, cy, r, { x: 0, y: 0, z: 1 });

    // Axis labels (clickable pole shortcuts)
    ctx.font = "10px 'Chakra Petch', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#64748b";
    for (const pole of POLES) {
      const pos = poleScreenPos(pole, cx, cy, r);
      ctx.fillText(pole.text, pos.x, pos.y);
    }

    // Bloch vector
    const v = blochVec(theta, phi);
    const tip = project(v);
    const tipX = cx + tip.x * r;
    const tipY = cy + tip.y * r;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(tipX, tipY, 4, 0, Math.PI * 2);
    ctx.fill();

    // Numeric readout in the bottom-left corner
    ctx.font = "9px 'Chakra Petch', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(`θ ${fmtPi(theta)}  φ ${fmtPi(phi)}`, 8, h - 8);
  }

  function drawGreatCircle(cx: number, cy: number, r: number, a: Vec3, b: Vec3) {
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    const STEPS = 60;
    for (let i = 0; i <= STEPS; i++) {
      const α = (i / STEPS) * Math.PI * 2;
      const ca = Math.cos(α), sa = Math.sin(α);
      const v: Vec3 = { x: ca * a.x + sa * b.x, y: ca * a.y + sa * b.y, z: ca * a.z + sa * b.z };
      const p = project(v);
      const sx = cx + p.x * r;
      const sy = cy + p.y * r;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  function drawAxis(cx: number, cy: number, r: number, vec: Vec3) {
    const p = project(vec);
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(cx - p.x * r, cy - p.y * r);
    ctx.lineTo(cx + p.x * r, cy + p.y * r);
    ctx.stroke();
  }

  // ── Interaction ──────────────────────────────────────────────────────

  function canvasPos(e: MouseEvent): Vec2 {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hitPole(x: number, y: number): PoleSpec | null {
    const { cx, cy, r } = getLayout();
    for (const pole of POLES) {
      const pos = poleScreenPos(pole, cx, cy, r);
      // ~14×14 hit box around the label centre
      if (Math.abs(x - pos.x) < 12 && Math.abs(y - pos.y) < 9) return pole;
    }
    return null;
  }

  function commit(t: number, p: number) {
    theta = clampTheta(t);
    phi = wrapPhi(p);
    opts.onChange(theta, phi);
    draw();
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const pos = canvasPos(e);
    dragMovedDistance = 0;
    lastX = pos.x;
    lastY = pos.y;
    dragging = true;
    canvas.style.cursor = "grabbing";
    e.preventDefault();
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragging) return;
    const pos = canvasPos(e);
    const dx = pos.x - lastX;
    const dy = pos.y - lastY;
    lastX = pos.x;
    lastY = pos.y;
    dragMovedDistance += Math.hypot(dx, dy);
    // Sensitivity: 1px ≈ 0.012 rad → a full canvas drag (~140px) sweeps ~π/2.
    const SENS = 0.012;
    const [t, p] = maybeSnap(theta + dy * SENS, phi + dx * SENS);
    commit(t, p);
  }

  function onMouseUp(e: MouseEvent) {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "grab";
    // Treat as a click on a pole label only if the cursor barely moved
    if (dragMovedDistance < 4) {
      const pos = canvasPos(e);
      const pole = hitPole(pos.x, pos.y);
      if (pole) {
        const [t, p] = maybeSnap(pole.theta, pole.phi);
        commit(t, p);
      }
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const step = opts.isSnapping() ? SNAP_STEP : Math.PI / 64;
    const dir = e.deltaY > 0 ? 1 : -1;
    const [t, p] = maybeSnap(theta, phi + dir * step);
    commit(t, p);
  }

  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  draw();

  return {
    setVector(t: number, p: number) {
      theta = clampTheta(t);
      phi = wrapPhi(p);
      draw();
    },
    setColor(c: string) {
      color = c;
      draw();
    },
    redraw: draw,
    destroy() {
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}

function fmtPi(rad: number): string {
  if (Math.abs(rad) < 1e-9) return "0";
  return (rad / Math.PI).toFixed(2) + "π";
}
