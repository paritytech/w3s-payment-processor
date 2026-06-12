// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v2 payment-flow telemetry: decorators + emitters wired in at the composition
 * root (`engine.ts`) so the domain interfaces (`ClaimEngine`,
 * `CoinsTopUpManager`, the orchestrator `deps`) stay frozen. Every export is
 * fire-and-forget — with Sentry uninitialised the SDK returns inert spans and
 * the privacy helpers never throw, so a telemetry fault can't break a claim.
 *
 * Spans (not the sunset metrics product): `payment.claim`, `payment.topup`,
 * `payment.outcome`, `payment.decode_failure`, each carrying
 * `Sentry.setMeasurement` values + categorical attributes. Errors propagate to
 * Sentry Issues via the scrubbed `captureError` helper.
 */

import * as Sentry from "@sentry/react";

import { breadcrumb, captureError, sanitizeExceptionMessage } from "@/shared/utils/telemetry/index.ts";
import type { ClaimEngine, CoinsTopUpManager } from "@/features/v2/api/claim-engine.ts";
import type { ClaimResult, PaymentRecord } from "@/features/v2/types.ts";

type SpanAttributes = Record<string, string | number | boolean>;

// Session state, deliberately module-level: a StrictMode remount or settings
// toggle restarts the monitor but must not re-alert on the same failure, and
// the queue counter must stay consistent across whichever monitor settles a
// claim. Cleared only by `resetTelemetryForTests`.
let pendingClaims = 0;
const capturedFailedClaims = new Set<string>();
const capturedBlockedClaims = new Set<string>();
const capturedDecodeFailures = new Set<string>();
const capturedDuplicates = new Set<string>();
let hostUnreachableCaptured = false;

/** Test seam: clears the dedupe sets, the queue counter, and the host-unreachable flag. */
export function resetTelemetryForTests(): void {
  pendingClaims = 0;
  capturedFailedClaims.clear();
  capturedBlockedClaims.clear();
  capturedDecodeFailures.clear();
  capturedDuplicates.clear();
  hostUnreachableCaptured = false;
}

/**
 * Wrap a claim engine so each `claim()` emits a `payment.claim` span carrying
 * its duration (incl. FIFO queue wait) and the live queue depth at enqueue.
 * Disabled engines are returned untouched — they settle instantly with a
 * blocked result the persist tap already records, so a span here is noise.
 */
export function instrumentClaimEngine(engine: ClaimEngine): ClaimEngine {
  if (!engine.enabled) return engine;
  return {
    enabled: engine.enabled,
    diagnostic: engine.diagnostic,
    claim(coins: Uint8Array[], amountPlanck: bigint): Promise<ClaimResult> {
      pendingClaims += 1;
      const queueDepth = pendingClaims;
      const startedAt = performance.now();
      return engine.claim(coins, amountPlanck).then(
        (result) => {
          pendingClaims -= 1;
          emitClaimSpan(result, coins.length, queueDepth, performance.now() - startedAt);
          return result;
        },
        (error) => {
          pendingClaims -= 1;
          throw error;
        },
      );
    },
  };
}

/**
 * Wrap the host top-up manager so each `topUp()` emits a `payment.topup` span
 * timing the host's finalisation of one attempt. The error is rethrown so the
 * claim engine's retry/diagnostic behaviour is unchanged.
 */
export function instrumentTopUpManager(manager: CoinsTopUpManager): CoinsTopUpManager {
  return {
    async topUp(amount: bigint, source: { type: "coins"; keys: Uint8Array[] }, into?: number): Promise<void> {
      const startedAt = performance.now();
      try {
        await manager.topUp(amount, source, into);
        emitTopupSpan({ ok: true, coinsCount: source.keys.length, durationMs: performance.now() - startedAt });
      } catch (error) {
        emitTopupSpan({
          ok: false,
          coinsCount: source.keys.length,
          durationMs: performance.now() - startedAt,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

/**
 * Emit the per-payment outcome span from a persisted record — the one place
 * that sees id + terminal + status + cumulative attempts together. Carries the
 * end-to-end `payment.e2e` measurement (customer-device send → claim finalised)
 * on claimed records, and a session-deduped `captureError` on failed/blocked/
 * duplicate (duplicates keyed by the settled payment id being re-presented).
 */
export function recordPaymentRecord(record: PaymentRecord): void {
  const claimed = record.claimStatus === "claimed";
  const attributes: SpanAttributes = {
    "claim.status": record.claimStatus,
    "terminal.id": record.terminalId,
    "cheque.id": record.id,
    "coins.count": record.coinsCount,
  };
  if (record.claimAttempts !== undefined) attributes["claim.attempts"] = record.claimAttempts;

  let e2eMs: number | undefined;
  if (claimed && record.claimedAtMs !== undefined && record.timestampMs !== undefined) {
    const raw = record.claimedAtMs - record.timestampMs;
    e2eMs = Math.max(0, raw);
    if (raw < 0) attributes["payment.e2e_skewed"] = true;
  }

  // Backdated to local decode time so the span's own duration is the
  // detection→settle interval — without an explicit startTime this span opens
  // and closes in the same tick and reports 0ms in the trace waterfall.
  Sentry.startSpan(
    { name: `payment:${record.claimStatus}`, op: "payment.outcome", attributes, startTime: record.firstSeenAtMs },
    (span) => {
      Sentry.setMeasurement("payment.success", claimed ? 1 : 0, "none", span);
      if (e2eMs !== undefined) Sentry.setMeasurement("payment.e2e", e2eMs, "millisecond", span);
      span.setStatus(claimed ? { code: 1, message: "ok" } : { code: 2, message: record.claimStatus });
    },
  );

  breadcrumb("claim settled", attributes, "app", claimed ? "info" : "error");

  if (record.claimStatus === "claim_failed") {
    if (!capturedFailedClaims.has(record.id)) {
      capturedFailedClaims.add(record.id);
      captureClaimFailure(record);
    }
  } else if (record.claimStatus === "claim_blocked") {
    const dedupeKey = `${record.terminalId}:${record.claimDiagnostic ?? ""}`;
    if (!capturedBlockedClaims.has(dedupeKey)) {
      capturedBlockedClaims.add(dedupeKey);
      captureClaimFailure(record);
    }
  } else if (record.claimStatus === "duplicate") {
    const dedupeKey = record.duplicateOfId ?? record.id;
    if (!capturedDuplicates.has(dedupeKey)) {
      capturedDuplicates.add(dedupeKey);
      captureError(
        new Error("duplicate payment: settled payment id re-presented"),
        { "claim.status": record.claimStatus, "terminal.id": record.terminalId },
        {
          chequeId: record.id,
          duplicateOfId: record.duplicateOfId ?? "",
          diagnostic: sanitizeExceptionMessage(record.claimDiagnostic ?? ""),
        },
      );
    }
  }
}

/**
 * Emit a `payment.decode_failure` span + once-per-(stage,topic) `captureError`
 * for an ECIES-decrypt / SCALE-decode / amount-parse failure. Fed by the
 * orchestrator's existing `onDecodeFailure` hook; `stage` is derived from the
 * stable reason prefixes so the orchestrator signature stays untouched.
 */
export function recordDecodeFailure(topicHex: string, reason: string, terminalId: string): void {
  const stage = reason.startsWith("decrypt failed")
    ? "decrypt"
    : reason.startsWith("amount parse failed")
      ? "amount_parse"
      : "unknown";
  const attributes: SpanAttributes = {
    "decode.stage": stage,
    "terminal.id": terminalId,
    "topic.prefix": topicHex.slice(0, 8),
  };
  Sentry.startSpan({ name: `decode:${stage}`, op: "payment.decode_failure", attributes }, (span) => {
    span.setStatus({ code: 2, message: stage });
  });
  breadcrumb("decode failure", attributes, "app", "error");

  const dedupeKey = `${stage}:${topicHex}`;
  if (!capturedDecodeFailures.has(dedupeKey)) {
    capturedDecodeFailures.add(dedupeKey);
    captureError(
      new Error(`decode failure: ${stage}`),
      { "decode.stage": stage, "terminal.id": terminalId },
      { reason: sanitizeExceptionMessage(reason) },
    );
  }
}

/** Breadcrumb + once-per-session `captureError` for an unreachable host product account. */
export function recordHostUnreachable(message: string): void {
  breadcrumb("host unreachable", undefined, "app", "warning");
  if (hostUnreachableCaptured) return;
  hostUnreachableCaptured = true;
  captureError(
    new Error("host product account unreachable"),
    { component: "v2-engine" },
    { reason: sanitizeExceptionMessage(message) },
  );
}

function emitClaimSpan(result: ClaimResult, coinsCount: number, queueDepth: number, durationMs: number): void {
  const attributes: SpanAttributes = {
    "claim.status": result.status,
    "coins.count": coinsCount,
    "claim.queue_depth": queueDepth,
  };
  if (result.attempts !== undefined) attributes["claim.attempts"] = result.attempts;
  // Backdated by the measured duration: the span is emitted after the claim
  // settles, and an explicit epoch-ms startTime is what gives it a real
  // duration instead of 0ms (the SDK ends it at "now" when the callback returns).
  Sentry.startSpan(
    { name: `claim:${result.status}`, op: "payment.claim", attributes, startTime: Date.now() - durationMs },
    (span) => {
      Sentry.setMeasurement("claim.duration", Math.round(durationMs), "millisecond", span);
      span.setStatus(result.status === "claimed" ? { code: 1, message: "ok" } : { code: 2, message: result.status });
    },
  );
}

function emitTopupSpan(args: { ok: boolean; coinsCount: number; durationMs: number; reason?: string }): void {
  const attributes: SpanAttributes = {
    "topup.ok": args.ok,
    "coins.count": args.coinsCount,
  };
  // Backdated like the claim span — see emitClaimSpan.
  Sentry.startSpan(
    { name: `topup:${args.ok ? "ok" : "fail"}`, op: "payment.topup", attributes, startTime: Date.now() - args.durationMs },
    (span) => {
      Sentry.setMeasurement("topup.duration", Math.round(args.durationMs), "millisecond", span);
      span.setStatus(args.ok ? { code: 1, message: "ok" } : { code: 2, message: (args.reason ?? "topup_failed").slice(0, 32) });
    },
  );
}

function captureClaimFailure(record: PaymentRecord): void {
  captureError(
    new Error(`claim failed after ${record.claimAttempts ?? 0} attempt(s)`),
    { "claim.status": record.claimStatus, "terminal.id": record.terminalId },
    { chequeId: record.id, diagnostic: sanitizeExceptionMessage(record.claimDiagnostic ?? "") },
  );
}
