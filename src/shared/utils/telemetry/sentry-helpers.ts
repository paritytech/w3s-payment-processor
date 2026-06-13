// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Thin wrappers around Sentry's tracing / breadcrumb / error surfaces. Each
 * funnels caller-supplied attributes through the privacy scrubber, so even a
 * stray `{ merchantId }` fails closed at the helper boundary instead of
 * leaking. They sit on top of JourneyTracker for the operations that aren't
 * multi-step journeys: point-in-time spans and stray crumbs / exceptions.
 */

import * as Sentry from "@sentry/react";
import type { Span } from "@sentry/react";

import { recordJourneyAttribute, scrubAttributes } from "./scrub.ts";

type AttrValue = string | number | boolean;

/**
 * Canonical Sentry `op` values for non-journey spans — a closed set so the
 * dashboard's `op` filter stays bounded. A runtime const map (not a bare type
 * union) so call sites reference `SpanOp.HOST_CALL` instead of a magic string;
 * the four `payment.*` ops mirror the strings the v2 telemetry already emits.
 */
export const SpanOp = {
  CHAIN_READ: "chain.read",
  CHAIN_WRITE: "chain.write",
  BULLETIN_PUBLISH: "bulletin.publish",
  HOST_CALL: "host.call",
  REGISTRY_READ: "registry.read",
  PAYMENT_CLAIM: "payment.claim",
  PAYMENT_TOPUP: "payment.topup",
  PAYMENT_OUTCOME: "payment.outcome",
  PAYMENT_DECODE_FAILURE: "payment.decode_failure",
} as const;
export type SpanOpValue = (typeof SpanOp)[keyof typeof SpanOp];

/**
 * Wrap an async operation in a Sentry span; it auto-ends when the promise
 * settles and `attributes` are scrubbed first. Errors propagate. Use for
 * one-shot async edges; use JourneyTracker for multi-step flows.
 */
export function withSpan<T>(
  name: string,
  op: SpanOpValue,
  fn: (span: Span) => Promise<T>,
  attributes?: Readonly<Record<string, AttrValue>>,
): Promise<T> {
  const scrubbed = scrubAttributes(attributes);
  // STRING "false"/"true" (not boolean) is the convention the SAD% dashboard facet queries.
  return Sentry.startSpan({ name, op, attributes: { "op.sad": "false", ...scrubbed } }, async (span) => {
    try {
      return await fn(span);
    } catch (caught) {
      // Re-throw after flagging so Sentry's span-error correlation captures it — no double-report.
      span.setAttribute("op.sad", "true");
      span.setStatus({ code: 2, message: caught instanceof Error ? caught.message : "unknown_error" });
      throw caught;
    }
  });
}

/**
 * Emit a structured breadcrumb; `data` keys are scrubbed first. `category`
 * defaults to "app" (both "app" and "telemetry" are on the allow-list).
 */
export function breadcrumb(
  message: string,
  data?: Readonly<Record<string, AttrValue>>,
  category: "app" | "telemetry" | "journey" = "app",
  level: "info" | "warning" | "error" = "info",
): void {
  const scrubbed = scrubAttributes(data);
  Sentry.addBreadcrumb({
    category,
    type: level === "error" ? "error" : "info",
    level,
    message,
    data: scrubbed,
  });
}

/**
 * Send an unhandled error to Sentry with scrubbed context. `tags` are filtered
 * through recordJourneyAttribute (a tag named "merchantId" is refused); `extras`
 * go on event.extra and are filtered again by beforeSend as defence in depth.
 */
export function captureError(
  error: unknown,
  tags?: Readonly<Record<string, AttrValue>>,
  extras?: Readonly<Record<string, unknown>>,
): void {
  // Tags are server-side indexed and surface everywhere, so scrub them more
  // strictly than extras (arbitrary metadata attached to the single event).
  const safeTags: Record<string, AttrValue> = {};
  if (tags) {
    for (const key of Object.keys(tags)) {
      const value = tags[key];
      if (value === undefined) continue;
      if (recordJourneyAttribute(key, value)) safeTags[key] = value;
    }
  }
  Sentry.captureException(error, {
    tags: safeTags,
    extra: extras as Record<string, unknown> | undefined,
  });
}

const EXPECTED_ERROR_RE =
  /insufficient funds|cancell?ed|declined|offline|no (?:internet|connection|network)|not bound|unbound|host unreachable|host unavailable|not signed[- ]?in|rejected|timed? ?out|timeout/i;

/**
 * Expected = a user/external constraint (offline, declined, host unavailable),
 * not a bug. Routes a failure to captureWarning instead of captureError so it
 * doesn't inflate the unexpected-failure rate. Empty/undefined → not expected.
 */
export function isExpectedError(reason: string | undefined | null): boolean {
  return reason ? EXPECTED_ERROR_RE.test(reason) : false;
}

/**
 * Record transient, non-fatal friction (retries, host drops, recovered
 * timeouts): a warning breadcrumb + a queryable warning message, and flips the
 * active root span's `op.sad="true"` so SAD% counts it. Never throws.
 */
export function captureWarning(message: string, context?: Readonly<Record<string, AttrValue>>): void {
  try {
    breadcrumb(message, context, "telemetry", "warning");
    Sentry.captureMessage(message, { level: "warning", extra: context as Record<string, unknown> | undefined });
    const active = Sentry.getActiveSpan();
    const root = active ? Sentry.getRootSpan(active) : null;
    if (root) root.setAttribute("op.sad", "true");
  } catch {
    /* telemetry must never throw */
  }
}
