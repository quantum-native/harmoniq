import { defineConfig } from "vite";
import { quantumForgeVitePlugin } from "quantum-forge/vite-plugin";

// quantumForgeVitePlugin's dev middleware serves resolve(cwd, "dist", <rest
// of the URL>) without checking for "..", and it runs ahead of Vite's
// server.fs checks. So /quantum-forge/quantum-forge-web-x/../../<any path>
// reads any file on the machine, over the LAN since the server runs with
// --host. Browsers collapse dot segments before sending, so no real request
// has one: refuse them all, raw or percent-encoded. This must sit before
// quantumForgeVitePlugin() so its middleware is registered first. It can go
// once the installed quantum-forge carries forge commit 7d13923.
function refuseDotSegments() {
  return {
    name: "refuse-dot-segments",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        let decoded;
        try {
          decoded = decodeURIComponent(path);
        } catch {
          decoded = null;
        }
        if (decoded === null || [path, decoded].some((p) => p.split(/[\\/]/).includes(".."))) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [refuseDotSegments(), quantumForgeVitePlugin()],
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
