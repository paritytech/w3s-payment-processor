// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Generic productivity-telemetry tracker for multi-step user flows. A
 * "journey" is a named, time-bounded flow with a discrete start, intermediate
 * milestones, and a terminal complete-or-fail edge.
 *
 * Emits ONE root span per journey plus one child phase span per milestone
 * (root op `ops[type]`, phase op `${ops[type]}.phase`), giving the Sentry
 * Performance waterfall its per-step breakdown without threading a span
 * through every product call site.
 *
 * Safe to use when Sentry is uninitialised: the span helpers return inert
 * spans whose methods are no-ops, and the tracker still emits the [Journey:*]
 * console waterfall so a DSN-less `npm run dev` observes the flow.
 *
 * Idempotency: start(name) is a no-op when `name` is already active (so it can
 * sit in a React effect without leaking a span on StrictMode's double-mount);
 * complete / fail on an inactive journey are no-ops too.
 *
 * Privacy: every attribute is filtered through recordJourneyAttribute (see
 * scrub.ts) — SENSITIVE_KEY_RE keys and over-length strings are refused.
 * Per-journey common attributes are filtered ONCE at construction.
 */

import * as Sentry from "@sentry/react";
import type { Span } from "@sentry/react";

import { recordJourneyAttribute, scrubAttributes } from "./scrub.ts";

/** Categorical / numeric / boolean — the only attribute shape we accept. */
export type JourneyAttrValue = string | number | boolean;

/** Map from journey kind → Sentry `op` for the root span. */
export type JourneyOpMap<T extends string> = Readonly<Record<T, string>>;

export interface JourneyTrackerOptions<T extends string> {
  /** Map from journey kind → Sentry `op` for the root span. */
  readonly ops: JourneyOpMap<T>;
  /**
   * Attributes attached to every span (root + phase), e.g. `app.name`,
   * `app.env`, `host.kind`. Scrubbed once at construction.
   */
  readonly commonAttributes?: Readonly<Record<string, JourneyAttrValue>>;
}

interface ActiveJourney {
  readonly rootSpan: Span;
  /** Current phase span; ended when the next milestone arrives. */
  phaseSpan: Span | null;
  readonly startMs: number;
  readonly logTag: string;
  /** Set true by markSad when the flow completed but with friction. */
  sad: boolean;
}

type AttrInput = Readonly<Record<string, JourneyAttrValue>> | undefined;

export class JourneyTracker<T extends string> {
  private readonly ops: JourneyOpMap<T>;
  private readonly commonAttrs: Readonly<Record<string, JourneyAttrValue>>;
  private readonly active = new Map<T, ActiveJourney>();

  constructor(options: JourneyTrackerOptions<T>) {
    this.ops = options.ops;
    // Scrub once at construction so callers don't pay the regex cost per start().
    this.commonAttrs = Object.freeze(scrubAttributes(options.commonAttributes));
  }

  /**
   * Open a journey of kind `name`. No-op when one is already active — safe to
   * colocate with a React effect that re-runs on StrictMode's double-mount.
   */
  start(name: T, attributes?: AttrInput): void {
    if (this.active.has(name)) return;
    const merged = this.mergeAttrs(attributes);
    const rootSpan = Sentry.startInactiveSpan({
      name,
      op: this.ops[name],
      attributes: merged,
    });
    const startMs = nowMs();
    this.active.set(name, {
      rootSpan,
      phaseSpan: null,
      startMs,
      logTag: `[Journey:${name}]`,
      sad: false,
    });
    console.info(`[Journey:${name}] started`);
    Sentry.addBreadcrumb({
      category: "journey",
      type: "info",
      level: "info",
      message: `${name}/start`,
      data: merged,
    });
  }

  /** Mark an in-flight journey as "sad" (completed but with friction). No-op when inactive. */
  markSad(name: T): void {
    const j = this.active.get(name);
    if (j) j.sad = true;
  }

  /**
   * Record an intermediate milestone: close the previous phase span (if any)
   * and open a new child of the root with op `${ops[name]}.phase` so the
   * waterfall groups cleanly under the root.
   */
  milestone(name: T, label: string, attributes?: AttrInput): void {
    const journey = this.active.get(name);
    if (!journey) return;
    journey.phaseSpan?.end();
    const merged = this.mergeAttrs(attributes);
    const phaseSpan = Sentry.startInactiveSpan({
      name: label,
      op: `${this.ops[name]}.phase`,
      attributes: merged,
      parentSpan: journey.rootSpan,
    });
    journey.phaseSpan = phaseSpan;
    const elapsed = Math.round(nowMs() - journey.startMs);
    console.info(`${journey.logTag} ${label} @${elapsed}ms`);
    Sentry.addBreadcrumb({
      category: "journey",
      type: "info",
      level: "info",
      message: `${name}/${label}`,
      data: { ...merged, "journey.elapsed_ms": elapsed },
    });
  }

  /**
   * Terminate a journey successfully: close the open phase, apply any final
   * `attributes`, and mark the root span ok.
   */
  complete(name: T, attributes?: AttrInput): void {
    const journey = this.active.get(name);
    if (!journey) return;
    journey.phaseSpan?.end();
    const merged = this.mergeAttrs(attributes);
    if (Object.keys(merged).length > 0) {
      journey.rootSpan.setAttributes(merged);
    }
    journey.rootSpan.setAttribute("journey.sad", journey.sad ? "true" : "false");
    journey.rootSpan.setStatus({ code: 1 /* OK */ });
    journey.rootSpan.end();
    this.active.delete(name);
    const elapsed = Math.round(nowMs() - journey.startMs);
    console.info(`${journey.logTag} completed in ${elapsed}ms`);
    Sentry.addBreadcrumb({
      category: "journey",
      type: "info",
      level: "info",
      message: `${name}/complete`,
      data: { ...merged, "journey.duration_ms": elapsed },
    });
  }

  /**
   * Terminate a journey unsuccessfully. `reason` is a categorical label
   * (closed set like "balance-low" / "host-unavailable") recorded as
   * journey.failure_reason and used as the span status message.
   *
   * When `caught` is provided the exception is ALSO forwarded to
   * Sentry.captureException, so failures show up in both the Performance
   * waterfall (failed span) AND the Issues stream (real exception). `caught`
   * is `unknown` so callers can pass the raw catch binding; the message goes
   * through sanitizeExceptionMessage inside beforeSend.
   */
  fail(name: T, reason: string, caught?: unknown, attributes?: AttrInput): void {
    const journey = this.active.get(name);
    if (!journey) return;
    journey.phaseSpan?.end();
    const merged = this.mergeAttrs(attributes);
    // The one attribute we set without recordJourneyAttribute: its value comes
    // from a closed set chosen by the call site, and we cap its length below.
    const safeReason = truncate(reason, 32);
    merged["journey.failure_reason"] = safeReason;
    journey.rootSpan.setAttributes(merged);
    journey.rootSpan.setAttribute("journey.sad", "true");
    journey.rootSpan.setStatus({ code: 2 /* ERROR */, message: safeReason });
    journey.rootSpan.end();
    this.active.delete(name);
    const elapsed = Math.round(nowMs() - journey.startMs);
    console.info(`${journey.logTag} failed (${safeReason}) in ${elapsed}ms`);
    Sentry.addBreadcrumb({
      category: "journey",
      type: "info",
      level: "warning",
      message: `${name}/fail:${safeReason}`,
      data: { ...merged, "journey.duration_ms": elapsed },
    });
    if (caught !== undefined) {
      const exception = caught instanceof Error ? caught : new Error(String(caught));
      // Tags are categorical only — commonAttrs already passed the
      // recordJourneyAttribute filter at construction.
      const tags: Record<string, JourneyAttrValue> = {
        ...this.commonAttrs,
        journey: name,
        "journey.failure_reason": safeReason,
      };
      Sentry.captureException(exception, { tags });
    }
  }

  /** True iff a journey of kind `name` is currently active. */
  isActive(name: T): boolean {
    return this.active.has(name);
  }

  /**
   * Attach additional attributes to an active journey's root span (same
   * scrubbing rules). No-op when the journey isn't active.
   */
  addAttributes(name: T, attributes: Record<string, JourneyAttrValue>): void {
    const journey = this.active.get(name);
    if (!journey) return;
    const merged = scrubAttributes(attributes);
    if (Object.keys(merged).length > 0) {
      journey.rootSpan.setAttributes(merged);
    }
  }

  private mergeAttrs(extra: AttrInput): Record<string, JourneyAttrValue> {
    const out: Record<string, JourneyAttrValue> = { ...this.commonAttrs };
    if (!extra) return out;
    for (const key of Object.keys(extra)) {
      const value = extra[key];
      if (value === undefined) continue;
      if (recordJourneyAttribute(key, value)) out[key] = value;
    }
    return out;
  }
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
