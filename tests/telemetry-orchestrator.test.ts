// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Verifies that claim.pipeline span attributes (claim.outcome, claim.sad,
 * pay.phase, payment.id) are set correctly for the main outcome branches.
 * The orchestrator is called through its real injected-deps seam; Sentry is
 * mocked so we can assert setAttribute calls without a real SDK.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";

// --- Sentry mock (must come before any import that transitively uses @sentry/react) ---
const mockAddBreadcrumb = vi.fn();
const mockCaptureMessage = vi.fn();
const mockGetActiveSpan = vi.fn();
const mockGetRootSpan = vi.fn();
const mockContinueTrace = vi.fn((_, fn: () => unknown) => fn());

/** Span stub whose setAttribute calls are recorded. */
function makeSpan() {
  const attrs: Record<string, unknown> = {};
  return {
    attrs,
    setAttribute: vi.fn((k: string, v: unknown) => { attrs[k] = v; }),
    setAttributes: vi.fn((obj: Record<string, unknown>) => { Object.assign(attrs, obj); }),
    setStatus: vi.fn(),
  };
}

type SpanStub = ReturnType<typeof makeSpan>;
let pipelineSpan: SpanStub;
let submitSpan: SpanStub;

const mockStartSpan = vi.fn((opts: { op?: string }, cb: (s: SpanStub) => unknown) => {
  const span = opts.op === "claim.submit" ? submitSpan : pipelineSpan;
  return cb(span);
});

vi.mock("@sentry/react", () => ({
  addBreadcrumb: (...a: unknown[]) => mockAddBreadcrumb(...a),
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  getActiveSpan: () => mockGetActiveSpan(),
  getRootSpan: (...a: unknown[]) => mockGetRootSpan(...a),
  startSpan: (opts: unknown, cb: (s: SpanStub) => unknown) =>
    mockStartSpan(opts as { op?: string }, cb),
  continueTrace: (_h: unknown, fn: () => unknown) => mockContinueTrace(_h, fn),
}));

import { hexToBytes } from "@noble/hashes/utils.js";
import { buildFixture } from "./encrypt-fixture.ts";
import { ingestStatement, indexTerminalsByTopic, type StatementLike } from "@/features/v2/api/orchestrator.ts";
import { createCoinsClaimEngine, createDisabledClaimEngine } from "@/features/v2/api/claim-engine.ts";
import type { PaymentRecord } from "@/features/v2/types.ts";
import type { ResolvedV2Terminal } from "@/config.ts";
import type { W3sPaymentDataV1 } from "@/shared/utils/wire/codec.ts";

const TOPIC_HEX = "d2cef99ad3b1681a79b73e4f806c77b63d7c06077905dd7afdb1df39e03746bf";

function makeTerminal(topicHex: string, terminalId: string): ResolvedV2Terminal {
  const privKey = p256.utils.randomSecretKey();
  const topic = hexToBytes(topicHex);
  return {
    topicId: topicHex,
    topic,
    topicHex,
    terminalId,
    payout: { accountId32: new Uint8Array(32), ss58: "x", hex: `0x${"0".repeat(64)}` },
    privKey,
    publicKeyUncompressed: p256.getPublicKey(privKey, false),
  };
}

function envelopeFor(terminal: ResolvedV2Terminal, payload: W3sPaymentDataV1): Uint8Array {
  return buildFixture({
    merchantPubCompressed: p256.getPublicKey(terminal.privKey, true),
    ephemeralPriv: new Uint8Array(32).fill(7),
    iv: new Uint8Array(12).fill(9),
    payload,
  }).envelopeBytes;
}

const basePayload: W3sPaymentDataV1 = {
  amount: "12.34",
  timestamp: 1_700_000_000_000n,
  coins: [new Uint8Array(64).fill(1), new Uint8Array(64).fill(2)],
  id: "pay-telemetry-1",
};

function baseDeps(terminal: ResolvedV2Terminal, records = new Map<string, PaymentRecord>()) {
  return {
    terminalsByTopic: indexTerminalsByTopic([terminal]),
    binding: { claimsEnabled: true, boundTerminalIds: new Set([terminal.terminalId]) },
    tokenDecimals: 6,
    records,
    inflight: new Set<string>(),
    sessionStartMs: 0,
    persist: async () => {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineSpan = makeSpan();
  submitSpan = makeSpan();
});

describe("claim.pipeline telemetry — outcome attributes", () => {
  it("sets claim.outcome=claimed, claim.sad=false, pay.phase=claimed on success", async () => {
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, basePayload) };

    await ingestStatement(statement, {
      ...baseDeps(terminal),
      claimEngine: createCoinsClaimEngine({ topUp: vi.fn(async () => undefined) }),
    });

    expect(pipelineSpan.attrs["claim.outcome"]).toBe("claimed");
    // claim.sad stays "false" on success (set via setAttributes in the successful branch)
    expect(pipelineSpan.attrs["claim.sad"]).toBe("false");
    expect(pipelineSpan.attrs["pay.phase"]).toBe("claimed");
    expect(pipelineSpan.attrs["payment.id"]).toBe("pay-telemetry-1");
    expect(pipelineSpan.attrs["pay.role"]).toBe("processor");
  });

  it("sets claim.outcome=blocked, claim.sad=true on claim_blocked", async () => {
    const terminal = makeTerminal(TOPIC_HEX, "t2");
    const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, basePayload) };

    await ingestStatement(statement, {
      ...baseDeps(terminal),
      claimEngine: createDisabledClaimEngine("R6"),
    });

    expect(pipelineSpan.attrs["claim.outcome"]).toBe("blocked");
    expect(pipelineSpan.attrs["claim.sad"]).toBe("true");
    expect(pipelineSpan.attrs["pay.phase"]).toBe("blocked");
  });

  it("sets claim.outcome=failed, claim.sad=true on claim_failed", async () => {
    const terminal = makeTerminal(TOPIC_HEX, "t3");
    const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, basePayload) };

    await ingestStatement(statement, {
      ...baseDeps(terminal),
      claimEngine: createCoinsClaimEngine(
        { topUp: async () => { throw new Error("host busy"); } },
        { retryDelayMs: 0, maxAttempts: 1 },
      ),
    });

    expect(pipelineSpan.attrs["claim.outcome"]).toBe("failed");
    expect(pipelineSpan.attrs["claim.sad"]).toBe("true");
    expect(pipelineSpan.attrs["pay.phase"]).toBe("failed");
  });

  it("calls captureWarning on decrypt failure (spam path)", async () => {
    const terminal = makeTerminal(TOPIC_HEX, "t5");
    const onDecodeFailure = vi.fn();

    await ingestStatement(
      { topics: [terminal.topic], data: new Uint8Array(120).fill(0xab) },
      {
        ...baseDeps(terminal),
        claimEngine: createCoinsClaimEngine({ topUp: vi.fn(async () => undefined) }),
        onDecodeFailure,
      },
    );

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "claim decrypt skipped",
      expect.objectContaining({ level: "warning" }),
    );
    expect(onDecodeFailure).toHaveBeenCalledOnce();
  });
});
