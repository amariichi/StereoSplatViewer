import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The mobile viewer's camera needs a secure origin, and a plain http:// address
// on a local network is not one. scripts/dev.sh issues a certificate and names
// it here. Without it the server stays on http, which is fine on the machine
// itself because browsers treat localhost as trustworthy.
const keyPath = process.env.SSV_TLS_KEY;
const certPath = process.env.SSV_TLS_CERT;
const https = keyPath && certPath
  ? { key: readFileSync(keyPath), cert: readFileSync(certPath) }
  : undefined;

const backend = process.env.SSV_BACKEND_ORIGIN ?? "http://127.0.0.1:8000";

// Vite refuses requests whose Host header it does not recognise, which is a
// defence against a hostile page pointing a name it controls at this dev server
// and reading the response. Reaching the viewer through `tailscale serve` means
// arriving with a tailnet name in the Host header, so that name has to be
// allowed or every request comes back 403 "Blocked request".
//
// Only names ending in .ts.net are accepted here, and only when scripts/dev.sh
// found one on this machine. A wide-open allowedHosts would give away exactly
// the protection this setting exists to provide.
const tailnetHost = process.env.SSV_TAILNET_HOST;
const allowedHosts = tailnetHost && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.ts\.net$/.test(tailnetHost)
  ? [tailnetHost]
  : undefined;

// Two pages: the editor at index.html and the head-coupled window at
// viewer.html. They share the renderer and nothing else, which is deliberate --
// the editor is a desktop tool with parameter panels, and the viewer is a phone
// page with no controls and a power budget.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // A phone on the same network has to be able to reach it.
    host: true,
    https,
    ...(allowedHosts ? { allowedHosts } : {}),
    // The backend is reached through this origin rather than named directly.
    // A page served over https calling a plain http address is a cross-origin
    // insecure request, and whether it is allowed is a browser policy decision
    // rather than something this project controls. Proxying removes the
    // question, and the CORS case with it.
    proxy: {
      "/api": { target: backend, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        viewer: resolve(__dirname, "viewer.html"),
      },
    },
  },
});
