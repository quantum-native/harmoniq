#!/usr/bin/env node

/**
 * Copy Quantum Forge WASM files to dist/quantum-forge/.
 *
 * Workaround: the vite plugin in the public `quantum-forge` package
 * has a hardcoded path to `@quantum-native/quantum-forge`. Until that's
 * fixed upstream, this script copies the WASM files after vite build.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const wasmFiles = [
  "quantum-forge-web-esm.mjs",
  "quantum-forge-web-esm.wasm",
  "quantum-forge-web-api.mjs",
];

const src = path.join(root, "node_modules", "quantum-forge", "dist");
const dest = path.join(root, "dist", "quantum-forge");

fs.mkdirSync(dest, { recursive: true });

for (const file of wasmFiles) {
  const srcPath = path.join(src, file);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(dest, file));
  } else {
    console.warn(`WASM file not found: ${srcPath}`);
  }
}

console.log(`Copied ${wasmFiles.length} WASM files to dist/quantum-forge/`);
