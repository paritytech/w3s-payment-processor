// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

// `./instrument` MUST be the first import so Sentry's global error handlers
// wire up before any other module evaluates and can throw at import time.
import "@/instrument.ts";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";

import { App } from "@/app/App.tsx";
import { ErrorBoundary } from "@/shared/components/ErrorBoundary.tsx";
import { armPaymentChime } from "@/shared/utils/chime.ts";
import "@/styles.css";

armPaymentChime();

const container = document.getElementById("root");
if (!container) throw new Error("missing #root container");

createRoot(container, {
  // React 19 routes caught / uncaught / recoverable errors through these
  // hooks. When telemetry is disabled the handler is an inert no-op.
  onCaughtError: Sentry.reactErrorHandler(),
  onUncaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
}).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
