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
 * dashboard's `op` filter stays bounded.
 */
export type SpanOp =
  | "chain.read"
  | "chain.write"
  | "bulletin.publish"
  | "host.call"
  | "registry.read";

/**
 * Wrap an async operation in a Sentry span; it auto-ends when the promise
 * settles and `attributes` are scrubbed first. Errors propagate. Use for
 * one-shot async edges; use JourneyTracker for multi-step flows.
 */
export function withSpan<T>(
  name: string,
  op: SpanOp,
  fn: (span: Span) => Promise<T>,
  attributes?: Readonly<Record<string, AttrValue>>,
): Promise<T> {
  const scrubbed = scrubAttributes(attributes);
  return Sentry.startSpan({ name, op, attributes: scrubbed }, async (span) => {
    try {
      return await fn(span);
    } catch (caught) {
      // Re-throw so the caller's error handling runs; Sentry's built-in
      // span-error correlation picks up the throw — we don't double-capture.
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
