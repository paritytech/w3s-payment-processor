import { describe, expect, it } from "vitest";

import { createMemoryKvStore } from "@/shared/utils/kv-store.ts";
import {
  appendTxLog,
  appendZReport,
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

  it("returns sensible empties for a fresh store", async () => {
    const kv = createMemoryKvStore();
    expect(await loadTxLog(kv)).toEqual([]);
    expect(await loadCheckpoint(kv)).toBeUndefined();
    expect(await loadReportState(kv)).toBeUndefined();
    expect(await loadZReports(kv)).toEqual([]);
  });
});
