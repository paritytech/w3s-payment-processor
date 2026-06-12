import { sentryVitePlugin } from "@sentry/vite-plugin";
/// <reference types="vitest" />
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    ...(process.env.VITE_W3SPAY_SENTRY_ENABLED === "true"
      ? [sentryVitePlugin({ org: "paritytech", project: "w3spay", telemetry: false })]
      : []),
  ],
  resolve: {

    alias: {
      "@": path.resolve(here, "src"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true
  },
  esbuild: {
    target: "es2022",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    env: {
      // config.ts throws at module load when this is unset (no defensible
      // default — a hardcoded value would silently mis-credit v2 claims in
      // production). Tests don't exercise the on-chain identity, so a
      // deterministic placeholder is sufficient and keeps CI from needing
      // to wire a real .dot per workflow.
      VITE_DOTNS_PRODUCT_DOMAIN: "test.dot",
    },
  },
});
