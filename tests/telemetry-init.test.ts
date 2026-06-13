// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Regression tests for the Sentry bootstrap. The payment-outcome spans are the
 * product's core telemetry; these tests pin the full pipeline (init → span →
 * transaction envelope) against the real SDK, plus the two init invariants
 * that broke it before:
 *
 *  - `integrations` MUST stay empty. `browserTracingIntegration` writes the
 *    pageload sampling decision into the scope's propagation context, and v8's
 *    sampler prefers `parentSampled` over `tracesSampleRate` — one unsampled
 *    pageload silenced every payment span for the whole session.
 *  - An empty DSN must keep the SDK fully offline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as Sentry from "@sentry/react";

import { initTelemetry } from "@/shared/utils/telemetry/init.ts";
import { recordPaymentRecord } from "@/features/v2/api/telemetry.ts";
import type { PaymentRecord } from "@/features/v2/types.ts";
import { _clearSecretsForTest, registerSecret } from "@/shared/utils/telemetry/index.ts";

const claimedRecord: PaymentRecord = {
  id: "pay-1",
  terminalId: "t1",
  topicHex: "0xabc",
  amount: "12.34",
  amountPlanck: "1234",
  coinsCount: 2,
  timestampMs: 1_000,
  firstSeenAtMs: 1_100,
  claimStatus: "claimed",
  claimAttempts: 1,
  claimedAtMs: 2_000,
  source: "v2",
};

function captureFetch(): string[] {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      sent.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  _clearSecretsForTest();
});

describe("initTelemetry", () => {
  it("sends a transaction envelope for a claimed payment record", async () => {
    const sent = captureFetch();
    initTelemetry({
      dsn: "https://pub@example.ingest.sentry.io/1",
      app: "test",
      environment: "test",
      tracesSampleRate: 1,
    });

    recordPaymentRecord(claimedRecord);
    await Sentry.flush(2_000);

    const transactions = sent.filter((body) => body.includes('"type":"transaction"'));
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toContain('"transaction":"payment:claimed"');
  });

  it("registers nothing beyond SDK defaults — in particular no BrowserTracing", () => {
    initTelemetry({ dsn: "https://pub@example.ingest.sentry.io/1", app: "test", environment: "test" });
    const client = Sentry.getClient();
    expect(client?.getIntegrationByName("BrowserTracing")).toBeUndefined();
    const integrations = (client?.getOptions().integrations ?? []) as Array<{ isDefaultInstance?: boolean }>;
    expect(integrations.every((integration) => integration.isDefaultInstance)).toBe(true);
    expect(client?.getOptions().tracePropagationTargets).toEqual([]);
  });

  it("never touches the network with an empty DSN", async () => {
    const sent = captureFetch();
    initTelemetry({ dsn: "", app: "test", environment: "test", tracesSampleRate: 1 });

    recordPaymentRecord(claimedRecord);
    Sentry.captureException(new Error("offline"));
    await Sentry.flush(2_000);

    expect(sent).toHaveLength(0);
  });

  it("redacts a registered secret from the outbound envelope", async () => {
    captureFetch();
    initTelemetry({ dsn: "https://pub@example.ingest.sentry.io/1", app: "test", environment: "test" });
    registerSecret("S3CR3T-passkey-bbbbbbbb");

    const envelopes: string[] = [];
    Sentry.getClient()?.on("beforeEnvelope", (envelope) => {
      envelopes.push(JSON.stringify(envelope));
    });

    Sentry.captureException(new Error("unlock failed for S3CR3T-passkey-bbbbbbbb"));
    await Sentry.flush(2_000);

    const joined = envelopes.join("\n");
    expect(envelopes.length).toBeGreaterThan(0);
    expect(joined).not.toContain("S3CR3T");
    expect(joined).toContain("«secret»");
  });
});
