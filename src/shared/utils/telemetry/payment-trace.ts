// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech
import * as Sentry from "@sentry/react";
const HEX32 = /^[0-9a-f]{32}$/;
function spanId(): string { const b = new Uint8Array(8); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }
/** Force the active Sentry trace_id to equal the payment id, so spans from every
 *  app handling this payment stitch into one cross-service trace. No-op fallback
 *  (normal trace) if the id isn't a valid 32-hex trace id. */
export function withPaymentTrace<T>(paymentId: string, fn: () => T): T {
  if (!HEX32.test(paymentId)) return fn();
  return Sentry.continueTrace({ sentryTrace: `${paymentId}-${spanId()}-1`, baggage: undefined }, fn);
}
