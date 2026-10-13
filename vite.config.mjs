import { defineConfig } from "vite";
import { quantumForgeVitePlugin } from "quantum-forge/vite-plugin";

export default defineConfig({
  plugins: [quantumForgeVitePlugin()],
  server: {
    fs: {
      // Sutradhar's dev desk keeps each job's brief, shots and server logs in
      // .devportal/, and this server runs with --host, so anyone on the LAN
      // could read them. Vite's own defaults go first: an array set here
      // replaces them rather than adding to them.
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        "**/.devportal/**",
      ],
    },
    allowedHosts: process.env.VITE_ALLOWED_HOSTS === "true"
      ? true
      : process.env.VITE_ALLOWED_HOSTS
        ? process.env.VITE_ALLOWED_HOSTS.split(",")
        : [],
  },
  build: {
    rollupOptions: {
      external: [/quantum-forge-web-api/],
    },
  },
});
