// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * `@/telemetry` — telemetry primitives for the w3spay family of apps.
 *
 *   - JourneyTracker<T>: span-emitter for multi-step user flows; a safe no-op
 *     when Sentry isn't initialised (still logs the [Journey:*] waterfall so
 *     dev gets the flow).
 *   - Sentry helpers: withSpan / breadcrumb / captureError — thin wrappers
 *     that funnel PII-bearing attributes through the scrubber.
 *   - initTelemetry: per-app bootstrap that pins sendDefaultPii: false, wires
 *     the beforeSend / beforeBreadcrumb scrubbers, and refuses
 *     Sentry.replayIntegration() (session replay would screen-record the
 *     confirm screen — never acceptable in a payments product).
 *
 * Privacy contract (see scrub.ts): attribute keys matching SENSITIVE_KEY_RE
 * and string values longer than MAX_ATTRIBUTE_LENGTH are rejected; refusals
 * always console.error but never throw, so a telemetry typo can't crash the
 * host app.
 */

export {
  JourneyTracker,
  type JourneyOpMap,
  type JourneyTrackerOptions,
  type JourneyAttrValue,
} from "./journey-tracker.ts";
export {
  withSpan,
  breadcrumb,
  captureError,
  captureWarning,
  isExpectedError,
  SpanOp,
  type SpanOpValue,
} from "./sentry-helpers.ts";
export {
  initTelemetry,
  type InitTelemetryOptions,
} from "./init.ts";
export { sentryRemoteOrigins } from "./origins.ts";
export {
  MAX_ATTRIBUTE_LENGTH,
  MAX_EXCEPTION_MESSAGE_LENGTH,
  SENSITIVE_KEY_RE,
  recordJourneyAttribute,
  sanitizeExceptionMessage,
  scrubAttributes,
  beforeSend,
  beforeBreadcrumb,
  registerSecret,
  _clearSecretsForTest,
  scrubTransaction,
} from "./scrub.ts";
