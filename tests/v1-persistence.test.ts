import { describe, expect, it } from "vitest";

import { createMemoryKvStore } from "@/shared/utils/kv-store.ts";
import {
  appendTxLog,
  appendZReport,
  clampPeriodStart,
  loadCheckpoint,
  loadReportState,
  loadTxLog,
  loadTxLogIds,
  loadZReports,
  saveCheckpoint,
  saveReportState,
  setEventReconciled,
} from "@/features/v1/api/persistence.ts";
import type { PaymentEvent, ZReportRecord } from "@/features/v1/types.ts";

function event(id: string, amountPlanck: string): PaymentEvent {
  return {
    paymentId: id,
    blockNumber: 10,
    blockHash: "0xblock",
    eventIndex: Number(id),
    source: "assets-transferred",
    terminalId: "till-1",
    payoutHex: `0x${"a".repeat(64)}`,
    amountPlanck,
    observedAtMs: 1,
    reconciled: false,
  };
}

describe("v1 persistence — durability across a simulated reload", () => {
  it("rehydrates tx-log, checkpoint, report-state, and z-reports from the same backing store", async () => {
    const backing = new Map<string, string>();
    const before = createMemoryKvStore(backing);

    await appendTxLog(before, [event("1", "1000"), event("2", "2000")]);
    await saveCheckpoint(before, 4242);
    await saveReportState(before, { periodStartBlock: 4000, lastZSeq: 1 });
    const zReport: ZReportRecord = {
      seq: 1,
      fromBlock: 1,
      toBlock: 100,
      lines: [{ terminalId: "till-1", payoutHex: `0x${"a".repeat(64)}`, totalPlanck: "3000", count: 2 }],
      grandTotalPlanck: "3000",
      count: 2,
      payments: [
        { paymentId: "1", terminalId: "till-1", amountPlanck: "1000", blockNumber: 10, observedAtMs: 1 },
        { paymentId: "2", terminalId: "till-1", amountPlanck: "2000", blockNumber: 10, observedAtMs: 1 },
      ],
      committedAtMs: 123,
      source: "v1",
      publishState: "pending",
    };
    await appendZReport(before, zReport);

    // Simulated reload: a fresh store over the SAME durable backing.
    const after = createMemoryKvStore(backing);
    expect((await loadTxLog(after)).map((e) => e.paymentId)).toEqual(["1", "2"]);
    expect(await loadCheckpoint(after)).toBe(4242);
    expect(await loadReportState(after)).toEqual({ periodStartBlock: 4000, lastZSeq: 1 });
    expect(await loadZReports(after)).toEqual([zReport]);
  });

  it("appends preserve order and the id index is the dedupe gate", async () => {
    const kv = createMemoryKvStore();
    await appendTxLog(kv, [event("1", "1")]);
    await appendTxLog(kv, [event("2", "2"), event("3", "3")]);
    expect(await loadTxLogIds(kv)).toEqual(new Set(["1", "2", "3"]));
    expect((await loadTxLog(kv)).map((e) => e.paymentId)).toEqual(["1", "2", "3"]);
  });

  it("setEventReconciled flips the flag on a stored event and persists it", async () => {
    const backing = new Map<string, string>();
    const kv = createMemoryKvStore(backing);
    await appendTxLog(kv, [event("1", "1000")]);
    await setEventReconciled(kv, "1", true);
    const reloaded = createMemoryKvStore(backing);
    expect((await loadTxLog(reloaded))[0]!.reconciled).toBe(true);
  });

  it("normalizes legacy z-report records persisted without payments or publishState", async () => {
    const backing = new Map<string, string>();
    // Raw write simulating a record persisted before the payments/publish features.
    const legacy = {
      seq: 1,
      fromBlock: 1,
      toBlock: 100,
      lines: [],
      grandTotalPlanck: "0",
      count: 0,
      committedAtMs: 5,
      source: "v1",
    };
    backing.set("w3s-payment-processor:v1-zreports:item:1", JSON.stringify(legacy));
    backing.set("w3s-payment-processor:v1-zreports:index", JSON.stringify([1]));

    const [record] = await loadZReports(createMemoryKvStore(backing));
    expect(record!.payments).toEqual([]);
    expect(record!.publishState).toBe("pending");
  });

  it("rebuilds legacy payments from the tx log when count and total match exactly", async () => {
    const backing = new Map<string, string>();
    const kv = createMemoryKvStore(backing);
    await appendTxLog(kv, [
      { ...event("late", "2000"), blockNumber: 140, fromHex: `0x${"b".repeat(64)}` },
      { ...event("early", "1000"), blockNumber: 110 },
      { ...event("outside", "999"), blockNumber: 160 }, // beyond toBlock
    ]);
    const legacy = {
      seq: 2,
      fromBlock: 100,
      toBlock: 150,
      lines: [{ terminalId: "till-1", payoutHex: `0x${"a".repeat(64)}`, totalPlanck: "3000", count: 2 }],
      grandTotalPlanck: "3000",
      count: 2,
      committedAtMs: 5,
      source: "v1",
    };
    backing.set("w3s-payment-processor:v1-zreports:item:2", JSON.stringify(legacy));
    backing.set("w3s-payment-processor:v1-zreports:index", JSON.stringify([2]));

    const [record] = await loadZReports(kv);
    expect(record!.payments.map((p) => p.paymentId)).toEqual(["early", "late"]);
    expect(record!.payments[1]!.fromHex).toBe(`0x${"b".repeat(64)}`);
    expect(record!.payments[0]).toMatchObject({ amountPlanck: "1000", blockNumber: 110 });
  });

  it("treats a corrupt toBlock:0 legacy record as an open window trimmed to count", async () => {
    // The seq-4 shape from the field: cut with nothing scanned (toBlock 0)
    // by a pre-guard build, while later open-period events exist in the log.
    const backing = new Map<string, string>();
    const kv = createMemoryKvStore(backing);
    await appendTxLog(kv, [
      { ...event("a", "1000"), blockNumber: 564500 },
      { ...event("b", "2000"), blockNumber: 564600 },
      { ...event("open-period", "5000"), blockNumber: 564700 }, // after the close
    ]);
    const legacy = {
      seq: 4,
      fromBlock: 564473,
      toBlock: 0,
      lines: [{ terminalId: "till-1", payoutHex: `0x${"a".repeat(64)}`, totalPlanck: "3000", count: 2 }],
      grandTotalPlanck: "3000",
      count: 2,
      committedAtMs: 5,
      source: "v1",
    };
    backing.set("w3s-payment-processor:v1-zreports:item:4", JSON.stringify(legacy));
    backing.set("w3s-payment-processor:v1-zreports:index", JSON.stringify([4]));

    const [record] = await loadZReports(kv);
    expect(record!.payments.map((p) => p.paymentId)).toEqual(["a", "b"]);
  });

  it("keeps an empty list when the log cannot reproduce the record exactly", async () => {
    const backing = new Map<string, string>();
    const kv = createMemoryKvStore(backing);
    await appendTxLog(kv, [{ ...event("only", "1000"), blockNumber: 110 }]);
    const legacy = {
      seq: 3,
      fromBlock: 100,
      toBlock: 150,
      lines: [],
      grandTotalPlanck: "9999", // does not match the log
      count: 1,
      committedAtMs: 5,
      source: "v1",
    };
    backing.set("w3s-payment-processor:v1-zreports:item:3", JSON.stringify(legacy));
    backing.set("w3s-payment-processor:v1-zreports:index", JSON.stringify([3]));

    const [record] = await loadZReports(kv);
    expect(record!.payments).toEqual([]); // fail-closed — never invented
  });

  it("clamps a poisoned period cursor below already-swept blocks", () => {
    const swept: ZReportRecord = {
      seq: 4,
      fromBlock: 564473,
      toBlock: 0, // corrupt — but the rebuilt payments carry the real blocks
      lines: [],
      grandTotalPlanck: "3000",
      count: 2,
      payments: [
        { paymentId: "a", terminalId: "t", amountPlanck: "1000", blockNumber: 564500, observedAtMs: 1 },
        { paymentId: "b", terminalId: "t", amountPlanck: "2000", blockNumber: 564600, observedAtMs: 2 },
      ],
      committedAtMs: 5,
      source: "v1",
      publishState: "published",
    };
    expect(clampPeriodStart({ periodStartBlock: 1, lastZSeq: 4 }, [swept])).toEqual({
      periodStartBlock: 564601,
      lastZSeq: 4,
    });
    // A healthy cursor (already past everything swept) is untouched.
    expect(clampPeriodStart({ periodStartBlock: 564601, lastZSeq: 4 }, [swept])).toEqual({
      periodStartBlock: 564601,
      lastZSeq: 4,
    });
    expect(clampPeriodStart({ periodStartBlock: 0, lastZSeq: 0 }, [])).toEqual({
      periodStartBlock: 0,
      lastZSeq: 0,
    });
  });

  it("returns sensible empties for a fresh store", async () => {
    const kv = createMemoryKvStore();
    expect(await loadTxLog(kv)).toEqual([]);
    expect(await loadCheckpoint(kv)).toBeUndefined();
    expect(await loadReportState(kv)).toBeUndefined();
    expect(await loadZReports(kv)).toEqual([]);
  });
});
