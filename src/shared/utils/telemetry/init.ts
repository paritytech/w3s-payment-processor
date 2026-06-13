// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import * as Sentry from "@sentry/react";
import { scrubEvent, scrubTransaction } from "./scrub";
import { getE2eTag } from "./e2e-tag";

/**
 * Minimal Sentry bootstrap for the payment processor. Privacy-first:
 * `sendDefaultPii: false`, no auto fetch/xhr/navigation instrumentation
 * (those carry chain endpoints + registry addresses), no session replay.
 *
 * Called once from `instrument.ts` only when a DSN is configured. With an
 * empty DSN the SDK initialises disabled — `captureException` becomes a
 * no-op — so call sites never need to branch on telemetry being on.
 */
export function initTelemetry(opts: {
  dsn: string;
  environment: string;
  /** Traces sample rate (0..1). Default 0.0 — opt-in per call site. */
  tracesSampleRate?: number;
  /** Release identifier (git sha / version). Optional — undefined omits the field. */
  release?: string;
}): void {
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    release: opts.release,
    sendDefaultPii: false,
    tracesSampleRate: opts.tracesSampleRate ?? 0.0,
    // Replay would screen-record the merchant unlock UI + payment confirms.
    // Pin both to 0.0 so a future SDK opt-in can't silently enable it.
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 0.0,
    integrations: [],
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubTransaction,
  });
  const t = getE2eTag(); if (t) Sentry.setTag("tag", t);
}
