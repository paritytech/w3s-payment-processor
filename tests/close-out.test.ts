/**
 * Rail-neutral fiscal close. A Z sweeps RFC-6 chain credits by block window
 * AND coin (statement) payments by wall-clock window since the last Z —
 * "it matters only about the amount that we record", not the rail. Claim
 * status is operational, not fiscal: blocked/failed coin payments still
 * count, matching the dashboard's running totals. `duplicate` records are the
 * exception — a refused re-tap of a settled sale moved no money.
 */
import { describe, expect, it } from "vitest";

import {
  buildCombinedSnapshot,
  commitCombinedZReport,
  fiscalPeriodStartMs,
  type CombinedPeriodInputs,
} from "@/features/reports/api/close-out.ts";
import type { PaymentEvent, V1Terminal, ZReportRecord } from "@/features/v1/types.ts";
import type { PaymentRecord } from "@/features/v2/types.ts";
import type { ResolvedV2Terminal } from "@/config.ts"

const A = `0x${"a".repeat(64)}`;

function v1Terminal(id: string, hex: string): V1Terminal {
  return { terminalId: id, payout: { accountId32: new Uint8Array(32), ss58: `ss58-${id}`, hex: hex as `0x${string}` } };
}

function v1Event(id: string, terminalId: string, hex: string, blockNumber: number, amountPlanck: string): PaymentEvent {
  return {
    blockHash: `0xb${blockNumber}`,
    paymentId: id,
    blockNumber,
    eventIndex: 0,
    source: "assets-transferred",
    terminalId,
    payoutHex: hex as `0x${string}`,
    amountPlanck,
    observedAtMs: 0,
    reconciled: false,
  };
}

function v2Terminal(terminalId: string, payoutHex: string): ResolvedV2Terminal {
  return {
    topicId: `topic-${terminalId}`,
    topic: new Uint8Array(32),
    topicHex: "ab".repeat(32),
    terminalId,
    payout: { accountId32: new Uint8Array(32), ss58: `ss58-${terminalId}`, hex: payoutHex as `0x${string}` },
    privKey: new Uint8Array(32),
    publicKeyUncompressed: new Uint8Array(65),
  };
}

function coinRecord(id: string, terminalId: string, amountPlanck: string, firstSeenAtMs: number, claimStatus: PaymentRecord["claimStatus"] = "claimed"): PaymentRecord {
  return {
    id,
    terminalId,
    topicHex: "ab".repeat(32),
    amount: "x",
    amountPlanck,
    coinsCount: 1,
    timestampMs: firstSeenAtMs,
    firstSeenAtMs,
    claimStatus,
    source: "v2",
  };
}

const BASE: CombinedPeriodInputs = {
  v1Events: [],
  periodStartBlock: 100,
  finalizedBlock: 150,
  v1Terminals: [v1Terminal("till-1", A)],
  v2Records: [],
  v2Terminals: [v2Terminal("tap-1", `0x${"c".repeat(64)}`)],
  periodStartMs: 1_000,
  nowMs: 10_000,
};

describe("fiscalPeriodStartMs", () => {
  it("is the latest Z commit time, 0 with no closes yet", () => {
    expect(fiscalPeriodStartMs([])).toBe(0);
    const z = (committedAtMs: number): ZReportRecord => ({
      seq: 1,
      fromBlock: 0,
      toBlock: 0,
      lines: [],
      grandTotalPlanck: "0",
      count: 0,
      payments: [],
      committedAtMs,
      source: "v1",
      publishState: "pending",
    });
    expect(fiscalPeriodStartMs([z(5), z(9), z(7)])).toBe(9);
  });
});

describe("buildCombinedSnapshot", () => {
  it("sweeps coin payments inside the wall-clock window and drops the rest", () => {
    const { snapshot, v2Count } = buildCombinedSnapshot({
      ...BASE,
      v2Records: [
        coinRecord("c-old", "tap-1", "5", 1_000), // exactly at boundary → already closed
        coinRecord("c-in", "tap-1", "7", 5_000),
        coinRecord("c-future", "tap-1", "9", 10_001), // after nowMs → next period
      ],
    });
    expect(v2Count).toBe(1);
    expect(snapshot.payments.map((p) => p.paymentId)).toEqual(["c-in"]);
    expect(snapshot.grandTotalPlanck).toBe("7");
    expect("blockNumber" in snapshot.payments[0]!).toBe(false);
  });

  it("counts blocked and failed coin payments — claim status is not fiscal", () => {
    const { snapshot } = buildCombinedSnapshot({
      ...BASE,
      v2Records: [
        coinRecord("c-1", "tap-1", "10", 2_000, "claimed"),
        coinRecord("c-2", "tap-1", "20", 3_000, "claim_blocked"),
        coinRecord("c-3", "tap-1", "30", 4_000, "claim_failed"),
      ],
    });
    expect(snapshot.count).toBe(3);
    expect(snapshot.grandTotalPlanck).toBe("60");
  });

  it("excludes duplicate records — a refused re-tap of a settled sale moved no money", () => {
    const dup = { ...coinRecord("c-1::dup::99", "tap-1", "10", 3_000, "duplicate"), duplicateOfId: "c-1" };
    const { snapshot, v2Count } = buildCombinedSnapshot({
      ...BASE,
      v2Records: [coinRecord("c-1", "tap-1", "10", 2_000, "claimed"), dup],
    });
    expect(v2Count).toBe(1);
    expect(snapshot.payments.map((p) => p.paymentId)).toEqual(["c-1"]);
    expect(snapshot.grandTotalPlanck).toBe("10");
    expect(snapshot.count).toBe(1);
  });

  it("merges both rails: v1 first (block-sorted), coins after (time-sorted); lines roll up per terminal", () => {
    const { snapshot, v1Count, v2Count } = buildCombinedSnapshot({
      ...BASE,
      v1Events: [v1Event("e-2", "till-1", A, 140, "100"), v1Event("e-1", "till-1", A, 120, "200")],
      v2Records: [coinRecord("c-2", "tap-1", "30", 6_000), coinRecord("c-1", "tap-1", "40", 5_000)],
    });
    expect(v1Count).toBe(2);
    expect(v2Count).toBe(2);
    expect(snapshot.payments.map((p) => p.paymentId)).toEqual(["e-1", "e-2", "c-1", "c-2"]);
    expect(snapshot.grandTotalPlanck).toBe("370");
    expect(snapshot.count).toBe(4);

    const byTerminal = new Map(snapshot.lines.map((l) => [l.terminalId, l]));
    expect(byTerminal.get("till-1")).toMatchObject({ totalPlanck: "300", count: 2 });
    expect(byTerminal.get("tap-1")).toMatchObject({ totalPlanck: "70", count: 2, payoutHex: `0x${"c".repeat(64)}` });
  });

  it("sums a till that recorded on both rails into one line", () => {
    const { snapshot } = buildCombinedSnapshot({
      ...BASE,
      v1Events: [v1Event("e-1", "till-1", A, 120, "100")],
      v2Records: [coinRecord("c-1", "till-1", "50", 5_000)],
      v2Terminals: [v2Terminal("till-1", `0x${"d".repeat(64)}`)],
    });
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]).toMatchObject({ terminalId: "till-1", totalPlanck: "150", count: 2, payoutHex: A });
  });
});

describe("commitCombinedZReport", () => {
  it("assigns the next seq and advances both period cursors", () => {
    const { record, nextState } = commitCombinedZReport(
      { ...BASE, v1Events: [v1Event("e-1", "till-1", A, 120, "10")] },
      2,
    );
    expect(record.seq).toBe(3);
    expect(record.source).toBe("v1");
    expect(record.committedAtMs).toBe(10_000);
    expect(record.publishState).toBe("pending");
    expect(nextState).toEqual({ periodStartBlock: 151, lastZSeq: 3 });
  });

  it("closes a coin-only period without touching the block cursor (v2-only setup)", () => {
    const { record, nextState } = commitCombinedZReport(
      {
        ...BASE,
        periodStartBlock: 0,
        finalizedBlock: 0, // chain watch never ran
        v1Terminals: [],
        v2Records: [coinRecord("c-1", "tap-1", "25", 5_000)],
      },
      0,
    );
    expect(record.seq).toBe(1);
    expect(record.source).toBe("v2");
    expect(record.grandTotalPlanck).toBe("25");
    expect(record.payments).toHaveLength(1);
    // Untouched: a later v1 enablement still seeds from its first scanned block.
    expect(nextState.periodStartBlock).toBe(0);
  });

  it("marks a period with both rails as mixed", () => {
    const { record } = commitCombinedZReport(
      {
        ...BASE,
        v1Events: [v1Event("e-1", "till-1", A, 120, "10")],
        v2Records: [coinRecord("c-1", "tap-1", "20", 5_000)],
      },
      0,
    );
    expect(record.source).toBe("mixed");
  });

  it("a follow-up Z over the advanced window does not double-count either rail", () => {
    const sharedV1 = [v1Event("e-1", "till-1", A, 120, "10")];
    const sharedV2 = [coinRecord("c-1", "tap-1", "20", 5_000)];
    const first = commitCombinedZReport({ ...BASE, v1Events: sharedV1, v2Records: sharedV2 }, 0);

    const second = commitCombinedZReport(
      {
        ...BASE,
        periodStartBlock: first.nextState.periodStartBlock,
        finalizedBlock: 170,
        v1Events: [...sharedV1, v1Event("e-2", "till-1", A, 160, "7")],
        v2Records: [...sharedV2, coinRecord("c-2", "tap-1", "9", 12_000)],
        periodStartMs: first.record.committedAtMs,
        nowMs: 20_000,
      },
      first.nextState.lastZSeq,
    );
    expect(second.record.seq).toBe(2);
    expect(second.record.payments.map((p) => p.paymentId)).toEqual(["e-2", "c-2"]);
    expect(second.record.grandTotalPlanck).toBe("16");
  });
});
