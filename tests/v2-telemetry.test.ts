// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fakeSpan = { setStatus: vi.fn(), setAttributes: vi.fn(), end: vi.fn() };
  type SpanOpts = {
    name: string;
    op: string;
    attributes: Record<string, string | number | boolean>;
    startTime?: number;
  };
  return {
    fakeSpan,
    startSpan: vi.fn((_opts: SpanOpts, cb: (span: typeof fakeSpan) => unknown) => cb(fakeSpan)),
    setMeasurement: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
  };
});

vi.mock("@sentry/react", () => ({
  startSpan: mocks.startSpan,
  setMeasurement: mocks.setMeasurement,
  addBreadcrumb: mocks.addBreadcrumb,
  captureException: mocks.captureException,
}));

import {
  instrumentClaimEngine,
  instrumentTopUpManager,
  recordDecodeFailure,
  recordPaymentRecord,
  resetTelemetryForTests,
} from "@/features/v2/api/telemetry.ts";
import { scrubAttributes } from "@/shared/utils/telemetry/index.ts";
import { createDisabledClaimEngine, type ClaimEngine } from "@/features/v2/api/claim-engine.ts";
import type { ClaimResult, PaymentRecord } from "@/features/v2/types.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function spanOpts(op: string): Array<{ op: string; name: string; attributes: Record<string, string | number | boolean>; startTime?: number }> {
  return mocks.startSpan.mock.calls.map(([opts]) => opts).filter((opts) => opts.op === op);
}

beforeEach(() => {
  resetTelemetryForTests();
  for (const spy of [mocks.startSpan, mocks.setMeasurement, mocks.addBreadcrumb, mocks.captureException]) {
    spy.mockClear();
  }
  mocks.fakeSpan.setStatus.mockClear();
});

describe("instrumentClaimEngine", () => {
  it("delegates args, returns the inner result, and emits one payment.claim span", async () => {
    const seen: { coins?: Uint8Array[]; amount?: bigint } = {};
    const inner: ClaimEngine = {
      enabled: true,
      claim: async (coins, amount) => {
        seen.coins = coins;
        seen.amount = amount;
        return { status: "claimed", attempts: 2 };
      },
    };
    const wrapped = instrumentClaimEngine(inner);
    const coins = [new Uint8Array(64), new Uint8Array(64)];

    const result = await wrapped.claim(coins, 42n);

    expect(seen.coins).toBe(coins);
    expect(seen.amount).toBe(42n);
    expect(result).toEqual({ status: "claimed", attempts: 2 });

    const spans = spanOpts("payment.claim");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["claim.status"]).toBe("claimed");
    expect(spans[0]!.attributes["claim.attempts"]).toBe(2);
    expect(spans[0]!.attributes["coins.count"]).toBe(2);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("claim.duration", expect.any(Number), "millisecond", mocks.fakeSpan);
  });

  it("backdates the span by the measured claim duration so it is not 0ms", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(3_500);
    vi.spyOn(Date, "now").mockReturnValue(100_000);

    const wrapped = instrumentClaimEngine({ enabled: true, claim: async () => ({ status: "claimed", attempts: 1 }) });
    await wrapped.claim([new Uint8Array(64)], 1n);

    expect(spanOpts("payment.claim")[0]!.startTime).toBe(97_500);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("claim.duration", 2500, "millisecond", mocks.fakeSpan);
    vi.restoreAllMocks();
  });

  it("records queue depth 1 then 2 for concurrent claims, and 1 again once they settle", async () => {
    const d1 = deferred<ClaimResult>();
    const d2 = deferred<ClaimResult>();
    const queue = [d1.promise, d2.promise];
    const wrapped = instrumentClaimEngine({ enabled: true, claim: () => queue.shift()! });

    const p1 = wrapped.claim([new Uint8Array(64)], 1n);
    const p2 = wrapped.claim([new Uint8Array(64)], 1n);
    d1.resolve({ status: "claimed", attempts: 1 });
    await p1;
    d2.resolve({ status: "claimed", attempts: 1 });
    await p2;

    expect(spanOpts("payment.claim").map((o) => o.attributes["claim.queue_depth"])).toEqual([1, 2]);

    mocks.startSpan.mockClear();
    const d3 = deferred<ClaimResult>();
    const p3 = instrumentClaimEngine({ enabled: true, claim: () => d3.promise }).claim([new Uint8Array(64)], 1n);
    d3.resolve({ status: "claimed", attempts: 1 });
    await p3;

    expect(spanOpts("payment.claim").map((o) => o.attributes["claim.queue_depth"])).toEqual([1]);
  });

  it("returns a disabled engine by reference and never spans", async () => {
    const disabled = createDisabledClaimEngine("standalone");
    const wrapped = instrumentClaimEngine(disabled);

    expect(wrapped).toBe(disabled);
    await wrapped.claim([new Uint8Array(64)], 1n);
    expect(spanOpts("payment.claim")).toHaveLength(0);
  });
});

describe("instrumentTopUpManager", () => {
  it("emits topup:ok with duration + coins.count and delegates verbatim", async () => {
    const topUp = vi.fn(async () => undefined);
    const wrapped = instrumentTopUpManager({ topUp });
    const keys = [new Uint8Array(64), new Uint8Array(64), new Uint8Array(64)];

    await wrapped.topUp(5n, { type: "coins", keys }, 7);

    expect(topUp).toHaveBeenCalledWith(5n, { type: "coins", keys }, 7);
    const spans = spanOpts("payment.topup");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["topup.ok"]).toBe(true);
    expect(spans[0]!.attributes["coins.count"]).toBe(3);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("topup.duration", expect.any(Number), "millisecond", mocks.fakeSpan);
  });

  it("backdates the span by the measured top-up duration so it is not 0ms", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(2_000).mockReturnValueOnce(6_000);
    vi.spyOn(Date, "now").mockReturnValue(50_000);

    await instrumentTopUpManager({ topUp: async () => undefined }).topUp(5n, { type: "coins", keys: [new Uint8Array(64)] });

    expect(spanOpts("payment.topup")[0]!.startTime).toBe(46_000);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("topup.duration", 4000, "millisecond", mocks.fakeSpan);
    vi.restoreAllMocks();
  });

  it("emits topup:fail and propagates the rejection", async () => {
    const wrapped = instrumentTopUpManager({
      topUp: async () => {
        throw new Error("host rejected");
      },
    });

    await expect(wrapped.topUp(5n, { type: "coins", keys: [new Uint8Array(64)] })).rejects.toThrow("host rejected");
    const spans = spanOpts("payment.topup");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["topup.ok"]).toBe(false);
  });
});

describe("recordPaymentRecord", () => {
  function record(overrides: Partial<PaymentRecord>): PaymentRecord {
    return {
      id: "a".repeat(32),
      terminalId: "955002-00",
      topicHex: "deadbeef".repeat(8),
      amount: "12.34",
      amountPlanck: "12340000",
      coinsCount: 2,
      timestampMs: 4_000,
      firstSeenAtMs: 9_000,
      claimStatus: "claimed",
      source: "v2",
      ...overrides,
    };
  }

  it("emits payment.success=1 and payment.e2e for a claimed record, without capturing", () => {
    recordPaymentRecord(record({ claimStatus: "claimed", claimedAtMs: 10_000, timestampMs: 4_000, claimAttempts: 1 }));

    const spans = spanOpts("payment.outcome");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startTime).toBe(9_000);
    expect(spans[0]!.attributes["terminal.id"]).toBe("955002-00");
    expect(spans[0]!.attributes["cheque.id"]).toBe("a".repeat(32));
    expect(mocks.setMeasurement).toHaveBeenCalledWith("payment.success", 1, "none", mocks.fakeSpan);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("payment.e2e", 6000, "millisecond", mocks.fakeSpan);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("clamps a clock-skewed e2e to 0 and flags it", () => {
    recordPaymentRecord(record({ claimStatus: "claimed", claimedAtMs: 3_000, timestampMs: 4_000 }));

    const spans = spanOpts("payment.outcome");
    expect(spans[0]!.attributes["payment.e2e_skewed"]).toBe(true);
    expect(mocks.setMeasurement).toHaveBeenCalledWith("payment.e2e", 0, "millisecond", mocks.fakeSpan);
  });

  it("captures a claim_failed record once, with hex redacted from the diagnostic", () => {
    const diagnostic = `topUp reverted: 0x${"a".repeat(64)}`;
    const failed = record({ claimStatus: "claim_failed", claimDiagnostic: diagnostic, claimAttempts: 3 });

    recordPaymentRecord(failed);
    recordPaymentRecord(failed);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [, context] = mocks.captureException.mock.calls[0] as [unknown, { extra: { diagnostic: string } }];
    expect(context.extra.diagnostic).not.toContain("a".repeat(64));
    expect(context.extra.diagnostic).toContain("«hex»");
  });

  it("dedupes claim_blocked by terminal+diagnostic", () => {
    recordPaymentRecord(record({ claimStatus: "claim_blocked", claimDiagnostic: "R6", terminalId: "t1" }));
    recordPaymentRecord(record({ claimStatus: "claim_blocked", claimDiagnostic: "R6", terminalId: "t1" }));
    expect(mocks.captureException).toHaveBeenCalledTimes(1);

    recordPaymentRecord(record({ claimStatus: "claim_blocked", claimDiagnostic: "binding failed", terminalId: "t1" }));
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });

  it("captures a duplicate once per settled payment id, with duplicateOfId in extras", () => {
    const settledId = "a".repeat(32);
    const dup = (tsMs: number) =>
      record({
        id: `${settledId}::dup::${tsMs}`,
        claimStatus: "duplicate",
        duplicateOfId: settledId,
        timestampMs: tsMs,
        claimDiagnostic: `repeat of payment ${settledId} — that sale was already settled; coins not claimed`,
      });

    recordPaymentRecord(dup(5_000));
    recordPaymentRecord(dup(5_000)); // gossip re-delivery of the same duplicate record
    recordPaymentRecord(dup(6_000)); // third tap of the same settled sale — still one alert

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [, context] = mocks.captureException.mock.calls[0] as [
      unknown,
      { tags: Record<string, string>; extra: { duplicateOfId: string } },
    ];
    expect(context.tags["claim.status"]).toBe("duplicate");
    expect(context.extra.duplicateOfId).toBe(settledId);

    // A different settled payment being re-presented is a fresh incident.
    recordPaymentRecord(record({ id: `${"b".repeat(32)}::dup::1`, claimStatus: "duplicate", duplicateOfId: "b".repeat(32) }));
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });
});

describe("recordDecodeFailure", () => {
  it("derives the stage from the reason prefix", () => {
    recordDecodeFailure("aabbccdd00", "decrypt failed (bad mac)", "t1");
    recordDecodeFailure("aabbccdd11", "amount parse failed (NaN)", "t1");
    recordDecodeFailure("aabbccdd22", "something unexpected", "t1");

    expect(spanOpts("payment.decode_failure").map((o) => o.attributes["decode.stage"])).toEqual([
      "decrypt",
      "amount_parse",
      "unknown",
    ]);
  });

  it("dedupes captureException per stage+topic but emits a span each time", () => {
    recordDecodeFailure("topicAAAA", "decrypt failed (x)", "t1");
    recordDecodeFailure("topicAAAA", "decrypt failed (y)", "t1");

    expect(spanOpts("payment.decode_failure")).toHaveLength(2);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });
});

describe("scrub deny-list divergence", () => {
  it("keeps terminal.id but still refuses amount", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(scrubAttributes({ "terminal.id": "t1" })).toEqual({ "terminal.id": "t1" });
    expect(scrubAttributes({ amount: "1.00" })).toEqual({});
    errorSpy.mockRestore();
  });
});
