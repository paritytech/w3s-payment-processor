// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * `initTelemetry` — single-call Sentry bootstrap for the w3spay family of apps.
 *
 * Pins privacy-critical defaults:
 *   - sendDefaultPii: false — pinned explicitly so a future SDK bump can't
 *     quietly opt us in.
 *   - beforeSend / beforeBreadcrumb from ./scrub.ts.
 *   - NO replayIntegration (replay would screen-record the confirm screen).
 *   - tracePropagationTargets: [] — never set `sentry-trace` on outgoing HTTP,
 *     because the RPC endpoints we talk to are third-party and we MUST NOT
 *     leak trace IDs to them.
 *
 * Empty `dsn` → Sentry.init runs with enabled: false: the SDK API surface
 * stays live (JourneyTracker still emits inert spans + console logs) but
 * nothing leaves the device. The kill-switch (config telemetry.enabled) is
 * checked earlier, in the per-app instrument.ts.
 */

import * as Sentry from "@sentry/react";

import { beforeBreadcrumb, beforeSend } from "./scrub.ts";

export interface InitTelemetryOptions {
  /** Sentry DSN. Empty string = console-only mode (no network calls). */
  readonly dsn: string;
  /** App identifier: the `app.name` tag on every event and the `release` prefix when `release` is omitted. */
  readonly app: string;
  /** Sentry environment label (e.g. `"production"`, `"pilot"`, `"dev"`). */
  readonly environment: string;
  /** Traces sample rate (0..1). Default 0.0 — opt-in per call site. */
  readonly tracesSampleRate?: number;
  /** Release identifier (git sha / version). Omitted → events ship without a release association. */
  readonly release?: string;

}

export function initTelemetry(options: InitTelemetryOptions): void {
  const dsn = options.dsn.trim();
  Sentry.init({
    dsn: dsn === "" ? undefined : dsn,
    enabled: dsn !== "",
    environment: options.environment,
    release: options.release,
    sendDefaultPii: false,
    tracesSampleRate: options.tracesSampleRate ?? 0.0,
    // Replay would screen-record the confirm screen (amount, terminal id,
    // host UI). Pin both to 0.0 so a future SDK opt-in can't silently enable.
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 0.0,
    // DELIBERATELY no `browserTracingIntegration`: auto-instrumenting page
    // loads, navigations, fetch, or XHR would attach span data containing
    // URLs (third-party RPC endpoints, Bulletin gateway, registry contract
    // address). Manual spans work without it. `tracePropagationTargets: []`
    // is defence in depth so that even if a future integration emits fetch
    // spans we never set `sentry-trace` / `baggage` on outgoing RPC calls.
    integrations: [],
    tracePropagationTargets: [],
    beforeSend,
    beforeBreadcrumb,
    initialScope: {
      tags: {
        "app.name": options.app,
        "app.env": options.environment,
      },
    },
  });
}
