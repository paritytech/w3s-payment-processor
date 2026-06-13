// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech
import * as Sentry from "@sentry/react";
const EXPECTED_ERROR_RE = /decrypt|decode|open[- ]?topic|mismatch|insufficient|declined|offline|no (?:internet|connection|network)|not bound|unbound|duplicate|already (?:settled|claimed)|timed? ?out|timeout/i;
export function isExpectedError(reason: string | undefined | null): boolean { return reason ? EXPECTED_ERROR_RE.test(reason) : false; }
export function captureWarning(message: string, context?: Record<string, unknown>): void {
  try { Sentry.addBreadcrumb({ level: "warning", message, data: context }); Sentry.captureMessage(message, { level: "warning", extra: context });
    const a = Sentry.getActiveSpan(); const r = a ? Sentry.getRootSpan(a) : null; if (r) r.setAttribute("op.sad", "true"); } catch { /* never throw */ }
}
export function withSpan<T>(name: string, op: string, fn: (s: Sentry.Span) => T, attributes: Record<string, string|number|boolean> = {}): T {
  return Sentry.startSpan({ name, op, attributes: { "op.sad": "false", ...attributes } }, (span) => {
    try { const r = fn(span);
      if (r instanceof Promise) return r.then((v) => { span.setStatus({ code: 1, message: "ok" }); return v; },
        (e) => { span.setAttribute("op.sad", "true"); span.setStatus({ code: 2, message: e instanceof Error ? e.message : "error" }); throw e; }) as T;
      span.setStatus({ code: 1, message: "ok" }); return r;
    } catch (e) { span.setAttribute("op.sad", "true"); span.setStatus({ code: 2, message: e instanceof Error ? e.message : "error" }); throw e; }
  });
}
