import { describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";

import { ingestStatement, indexTerminalsByTopic, type StatementLike } from "@/features/v2/api/orchestrator.ts";
import { createCoinsClaimEngine, createDisabledClaimEngine, type ClaimEngine } from "@/features/v2/api/claim-engine.ts";
import type { PaymentRecord } from "@/features/v2/types.ts";
import type { ResolvedV2Terminal } from "@/config.ts"
import { hexToBytes } from "@noble/hashes/utils.js";
import { buildFixture } from "./encrypt-fixture.ts";
import { W3sPaymentDataV1Codec, type W3sPaymentDataV1 } from "@/shared/utils/wire/codec.ts";
const TOPIC_HEX = "d2cef99ad3b1681a79b73e4f806c77b63d7c06077905dd7afdb1df39e03746bf";
const OTHER_TOPIC_HEX = "440f57027cce8034d4cdc0283f8a37618bc45ff33f950781facc5147f2b557a8";

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

const payload: W3sPaymentDataV1 = {
  amount: "12.34",
  timestamp: 1_700_000_000_000n,
  coins: [new Uint8Array(64).fill(1), new Uint8Array(64).fill(2)],
  id: "pay-1",
};

describe("ingestStatement — happy path", () => {
  it("decrypts, claims into the host wallet, and persists a claimed record", async () => {
    const topUp = vi.fn(async () => undefined);
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    const persisted: PaymentRecord[] = [];
    const records = new Map<string, PaymentRecord>();
    const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, payload) };

    const record = await ingestStatement(statement, {
      terminalsByTopic: indexTerminalsByTopic([terminal]),
      claimEngine: createCoinsClaimEngine({ topUp }),
      binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
      tokenDecimals: 6,
      records,
      inflight: new Set<string>(),
      sessionStartMs: 0,
      persist: async (r) => void persisted.push(r),
      now: () => 5_000,
    });

    expect(record).toMatchObject({
      id: "pay-1",
      terminalId: "t1",
      amount: "12.34",
      amountPlanck: "12340000",
      coinsCount: 2,
      timestampMs: 1_700_000_000_000,
      claimStatus: "claimed",
      claimedAtMs: 5_000,
      source: "v2",
    });
    expect(topUp).toHaveBeenCalledOnce();
    expect(topUp).toHaveBeenCalledWith(12_340_000n, { type: "coins", keys: payload.coins });
    expect(persisted).toHaveLength(1);
    expect(records.get("pay-1")).toBe(record);
  });
});

describe("ingestStatement — routing + spam resistance", () => {
  it("ignores a statement on a topic we do not watch", async () => {
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    const record = await ingestStatement(
      { topics: [hexToBytes(OTHER_TOPIC_HEX)], data: new Uint8Array([1, 2, 3]) },
      {
        terminalsByTopic: indexTerminalsByTopic([terminal]),
        claimEngine: createCoinsClaimEngine({ topUp: vi.fn(async () => undefined) }),
        binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
        tokenDecimals: 6,
        records: new Map(),
        inflight: new Set<string>(),
        sessionStartMs: 0,
        persist: async () => {},
      },
    );
    expect(record).toBeNull();
  });

  it("counts and ignores undecryptable data on a watched topic", async () => {
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    const onDecodeFailure = vi.fn();
    const persisted: PaymentRecord[] = [];
    const record = await ingestStatement(
      { topics: [terminal.topic], data: new Uint8Array(120).fill(0xab) },
      {
        terminalsByTopic: indexTerminalsByTopic([terminal]),
        claimEngine: createCoinsClaimEngine({ topUp: vi.fn(async () => undefined) }),
        binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
        tokenDecimals: 6,
        records: new Map(),
        inflight: new Set<string>(),
        sessionStartMs: 0,
        persist: async (r) => void persisted.push(r),
        onDecodeFailure,
      },
    );
    expect(record).toBeNull();
    expect(onDecodeFailure).toHaveBeenCalledWith(terminal.topicHex, expect.any(String));
    expect(persisted).toHaveLength(0);
  });
});

describe("ingestStatement — dedupe + idempotency", () => {
  it("claims once and returns the existing record on re-delivery (and across a restart)", async () => {
    const topUp = vi.fn(async () => undefined);
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    const records = new Map<string, PaymentRecord>();
    const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, payload) };
    const d = {
      terminalsByTopic: indexTerminalsByTopic([terminal]),
      claimEngine: createCoinsClaimEngine({ topUp }),
      binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
      tokenDecimals: 6,
      records,
      inflight: new Set<string>(),
      sessionStartMs: 0,
      persist: async () => {},
    };

    const first = await ingestStatement(statement, d);
    const second = await ingestStatement(statement, d); // re-delivered same page
    // Simulated restart: a fresh deps with the rehydrated records map.
    const third = await ingestStatement(statement, { ...d, records: new Map(records) });

    expect(first?.claimStatus).toBe("claimed");
    expect(second).toBe(first);
    expect(third?.claimStatus).toBe("claimed");
    expect(topUp).toHaveBeenCalledOnce();
  });

  it(
    "dedupes a concurrent re-delivery while the first claim is in flight " +
      "(statement-store gossip re-emits the same statement every few seconds, " +
      "without this guard each re-delivery fires a fresh paymentTopUp)",
    async () => {
      // Hold the host's response until we explicitly resolve it — simulates a
      // real chain top-up taking seconds to settle (or the production hang
      // where the response message is dropped at `Message.dec`).
      let releaseTopUp: () => void = () => {};
      let releaseStarted: () => void = () => {};
      const topUpStarted = new Promise<void>((resolve) => {
        // Resolved as soon as the FIRST `topUp` call begins, so the test can
        // deterministically race the second `ingestStatement` against it.
        releaseStarted = resolve;
      });
      const topUp = vi.fn(async () => {
        releaseStarted();
        await new Promise<void>((resolve) => { releaseTopUp = resolve; });
      });
      const terminal = makeTerminal(TOPIC_HEX, "t1");
      const records = new Map<string, PaymentRecord>();
      const inflight = new Set<string>();
      const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, payload) };
      const d = {
        terminalsByTopic: indexTerminalsByTopic([terminal]),
        claimEngine: createCoinsClaimEngine({ topUp }),
        binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
        tokenDecimals: 6,
        records,
        inflight,
        sessionStartMs: 0,
        persist: async () => {},
      };

      const first = ingestStatement(statement, d);
      await topUpStarted; // first call has registered itself in `inflight`
      const second = await ingestStatement(statement, d); // arrives while first is pending
      expect(second).toBeNull();
      expect(inflight.has("pay-1")).toBe(true);

      releaseTopUp();
      const firstResult = await first;
      expect(firstResult?.claimStatus).toBe("claimed");
      expect(topUp).toHaveBeenCalledOnce();
      expect(inflight.has("pay-1")).toBe(false); // released in finally
    },
  );

  it("skips a stale-backlog statement whose payload timestamp predates sessionStartMs (no topUp fired)", async () => {
    const topUp = vi.fn(async () => undefined);
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    // payload.timestamp = 1_700_000_000_000 (2023-11-15); sessionStartMs is in
    // 2027 — well after — so this cheque is treated as backlog and dropped
    // before the claim path.
    const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, payload) };
    const record = await ingestStatement(statement, {
      terminalsByTopic: indexTerminalsByTopic([terminal]),
      claimEngine: createCoinsClaimEngine({ topUp }),
      binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
      tokenDecimals: 6,
      records: new Map(),
      inflight: new Set<string>(),
      sessionStartMs: 1_800_000_000_000, // 2027-01
      persist: async () => {},
    });
    expect(record).toBeNull();
    expect(topUp).not.toHaveBeenCalled();
  });
});

describe("ingestStatement — retry semantics", () => {
  it("claims even when the terminal payout differs from the host wallet", async () => {
    const claim = vi.fn(async () => ({ status: "claimed" as const }));
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    const record = await ingestStatement(
      { topics: [terminal.topic], data: envelopeFor(terminal, payload) },
      {
        terminalsByTopic: indexTerminalsByTopic([terminal]),
        claimEngine: { enabled: true, claim },
        binding: { claimsEnabled: true, boundTerminalIds: new Set() }, // payout mismatch no longer blocks
        tokenDecimals: 6,
        records: new Map(),
        inflight: new Set<string>(),
        sessionStartMs: 0,
        persist: async () => {},
      },
    );
    expect(record?.claimStatus).toBe("claimed");
    expect(claim).toHaveBeenCalledOnce();
  });

  it("blocks under a disabled (R6/standalone) engine but retries to claimed when re-delivered enabled", async () => {
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    const records = new Map<string, PaymentRecord>();
    const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, payload) };

    const blocked = await ingestStatement(statement, {
      terminalsByTopic: indexTerminalsByTopic([terminal]),
      claimEngine: createDisabledClaimEngine("R6"),
      binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
      tokenDecimals: 6,
      records,
      inflight: new Set<string>(),
      sessionStartMs: 0,
      persist: async () => {},
      now: () => 1_000,
    });
    expect(blocked?.claimStatus).toBe("claim_blocked");
    expect(blocked?.firstSeenAtMs).toBe(1_000);

    const claimed = await ingestStatement(statement, {
      terminalsByTopic: indexTerminalsByTopic([terminal]),
      claimEngine: createCoinsClaimEngine({ topUp: vi.fn(async () => undefined) }),
      binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
      tokenDecimals: 6,
      records,
      inflight: new Set<string>(),
      sessionStartMs: 0,
      persist: async () => {},
      now: () => 2_000,
    });
    expect(claimed?.claimStatus).toBe("claimed");
    expect(claimed?.firstSeenAtMs).toBe(1_000); // preserved across the retry
    expect(claimed?.claimedAtMs).toBe(2_000);
  });
});

describe("ingestStatement — coin secret length contract (regression)", () => {
  // The wire/claim contract is a 64-byte sr25519 secret key (32B scalar ‖ 32B
  // nonce); host-api `Sr25519SecretKey = Bytes(64)`. The earlier fixtures used
  // 32-byte synthetic coins, masking that a real cheque was being dropped as a
  // decode failure and never claimed.
  it("claims a real 64-byte cheque end-to-end and forwards 64-byte keys with the parsed planck amount", async () => {
    const topUp = vi.fn(async () => undefined);
    const terminal = makeTerminal(TOPIC_HEX, "t9");
    const cheque: W3sPaymentDataV1 = {
      amount: "7.50",
      timestamp: 1_700_000_000_000n,
      coins: [new Uint8Array(64).fill(0xab), new Uint8Array(64).fill(0xcd)],
      id: "pay-64",
    };

    const record = await ingestStatement(
      { topics: [terminal.topic], data: envelopeFor(terminal, cheque) },
      {
        terminalsByTopic: indexTerminalsByTopic([terminal]),
        claimEngine: createCoinsClaimEngine({ topUp }),
        binding: { claimsEnabled: true, boundTerminalIds: new Set(["t9"]) },
        tokenDecimals: 6,
        records: new Map(),
        inflight: new Set<string>(),
        sessionStartMs: 0,
        persist: async () => {},
      },
    );

    expect(record?.claimStatus).toBe("claimed");
    expect(record?.coinsCount).toBe(2);
    expect(topUp).toHaveBeenCalledWith(7_500_000n, { type: "coins", keys: cheque.coins });
  });

  it("drops an out-of-contract 32-byte cheque at decode and never claims it", async () => {
    const topUp = vi.fn(async () => undefined);
    const onDecodeFailure = vi.fn();
    const persisted: PaymentRecord[] = [];
    const terminal = makeTerminal(TOPIC_HEX, "t9");
    // Forge a plaintext carrying a legacy 32-byte coin (bypassing the validating
    // encoder), then encrypt it like a real sender. The receiver must reject it
    // at decode rather than silently accept an unclaimable coin.
    const rawPlaintext = W3sPaymentDataV1Codec.enc({
      amount: "9.99",
      timestamp: 1_700_000_000_000n,
      coins: [new Uint8Array(32).fill(1)],
      id: "legacy-32",
    });
    const data = buildFixture({
      merchantPubCompressed: p256.getPublicKey(terminal.privKey, true),
      ephemeralPriv: new Uint8Array(32).fill(7),
      iv: new Uint8Array(12).fill(9),
      payload: { amount: "0.00", timestamp: 0n, coins: [], id: "ignored" },
      rawPlaintext,
    }).envelopeBytes;

    const record = await ingestStatement(
      { topics: [terminal.topic], data },
      {
        terminalsByTopic: indexTerminalsByTopic([terminal]),
        claimEngine: createCoinsClaimEngine({ topUp }),
        binding: { claimsEnabled: true, boundTerminalIds: new Set(["t9"]) },
        tokenDecimals: 6,
        records: new Map(),
        inflight: new Set<string>(),
        sessionStartMs: 0,
        persist: async (r) => void persisted.push(r),
        onDecodeFailure,
      },
    );

    expect(record).toBeNull();
    expect(onDecodeFailure).toHaveBeenCalledWith(terminal.topicHex, expect.any(String));
    expect(topUp).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });
});

describe("ingestStatement — retry accounting", () => {
  it("accumulates topUp attempts across re-deliveries and says so in the record", async () => {
    const terminal = makeTerminal(TOPIC_HEX, "t1");
    const records = new Map<string, PaymentRecord>();
    const deps = (claimEngine: ClaimEngine) => ({
      terminalsByTopic: indexTerminalsByTopic([terminal]),
      claimEngine,
      binding: { claimsEnabled: true, boundTerminalIds: new Set(["t1"]) },
      tokenDecimals: 6,
      records,
      inflight: new Set<string>(),
      sessionStartMs: 0,
      persist: async () => {},
    });
    const statement: StatementLike = { topics: [terminal.topic], data: envelopeFor(terminal, payload) };

    // First delivery: the host stays down — 3 attempts, then a failed record.
    const failing = createCoinsClaimEngine(
      {
        topUp: async () => {
          throw new Error("host busy");
        },
      },
      { retryDelayMs: 0 },
    );
    const first = await ingestStatement(statement, deps(failing));
    expect(first).toMatchObject({ claimStatus: "claim_failed", claimAttempts: 3 });
    expect(first!.claimDiagnostic).toBe("failed after 3 attempts — host busy");

    // Gossip re-delivers; still down — the record now says 6 tries in total.
    const second = await ingestStatement(statement, deps(failing));
    expect(second).toMatchObject({ claimStatus: "claim_failed", claimAttempts: 6 });
    expect(second!.claimDiagnostic).toBe("failed after 6 attempts — host busy");

    // Host recovers on the next re-delivery: claimed, history preserved.
    const recovered = createCoinsClaimEngine({ topUp: async () => undefined });
    const third = await ingestStatement(statement, deps(recovered));
    expect(third).toMatchObject({ claimStatus: "claimed", claimAttempts: 7 });
    expect(third!.claimDiagnostic).toBeUndefined();
  });
});
