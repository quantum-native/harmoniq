import { defineConfig } from "vite";
import { quantumForgeVitePlugin } from "@quantum-native/quantum-forge/vite-plugin";

export default defineConfig({
  plugins: [quantumForgeVitePlugin()],
  server: {
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
