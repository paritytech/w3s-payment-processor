import { describe, expect, it } from "vitest";

import { computeReport } from "@/features/v1/api/reports.ts";
import type { PaymentEvent, V1Terminal } from "@/features/v1/types.ts";

function terminal(id: string, hex: string): V1Terminal {
  return { terminalId: id, payout: { accountId32: new Uint8Array(32), ss58: `ss58-${id}`, hex: hex as `0x${string}` } };
}

function event(id: string, terminalId: string, hex: string, blockNumber: number, amountPlanck: string): PaymentEvent {
  return {
    paymentId: id,
    blockNumber,
    blockHash: `0x${id}`,
    eventIndex: 0,
    source: "assets-transferred",
    terminalId,
    payoutHex: hex,
    amountPlanck,
    observedAtMs: 0,
    reconciled: false,
  };
}

const A = `0x${"a".repeat(64)}`;
const B = `0x${"b".repeat(64)}`;
const C = `0x${"c".repeat(64)}`;
const terminals = [terminal("t-a", A), terminal("t-b", B), terminal("t-c", C)];

describe("computeReport", () => {
  it("sums per terminal within the block period and includes zero-activity terminals", () => {
    const events = [
      event("1", "t-a", A, 100, "1000000"),
      event("2", "t-a", A, 120, "500000"),
      event("3", "t-b", B, 150, "250000"),
    ];
    const report = computeReport(events, 100, 150, terminals);
    const byId = new Map(report.lines.map((l) => [l.terminalId, l]));
    expect(byId.get("t-a")).toMatchObject({ totalPlanck: "1500000", count: 2 });
    expect(byId.get("t-b")).toMatchObject({ totalPlanck: "250000", count: 1 });
    expect(byId.get("t-c")).toMatchObject({ totalPlanck: "0", count: 0 });
    expect(report.grandTotalPlanck).toBe("1750000");
    expect(report.count).toBe(3);
  });

  it("excludes events outside [fromBlock, toBlock]", () => {
    const events = [
      event("1", "t-a", A, 99, "1000000"), // before period
      event("2", "t-a", A, 100, "1"), // first block of period
      event("3", "t-a", A, 151, "9999"), // after period
    ];
    const report = computeReport(events, 100, 150, terminals);
    expect(report.grandTotalPlanck).toBe("1");
    expect(report.count).toBe(1);
  });

  it("keeps a line for an on-chain terminal absent from current config", () => {
    const report = computeReport([event("1", "t-x", `0x${"e".repeat(64)}`, 100, "42")], 100, 150, terminals);
    expect(report.lines.find((l) => l.terminalId === "t-x")).toMatchObject({ totalPlanck: "42", count: 1 });
  });

  it("collects one line item per in-range payment, sorted by block then paymentId", () => {
    const events = [
      event("b", "t-a", A, 120, "2"),
      event("z", "t-b", B, 100, "1"),
      event("a", "t-a", A, 120, "3"),
      event("x", "t-a", A, 99, "9"), // before period
      event("y", "t-a", A, 151, "9"), // after period
    ];
    const report = computeReport(events, 100, 150, terminals);
    expect(report.payments.map((p) => p.paymentId)).toEqual(["z", "a", "b"]);
    expect(report.payments[0]).toEqual({
      paymentId: "z",
      terminalId: "t-b",
      amountPlanck: "1",
      blockNumber: 100,
      observedAtMs: 0,
    });
  });

  it("passes fromHex through when present and omits the key when absent", () => {
    const withFrom = { ...event("1", "t-a", A, 100, "5"), fromHex: B };
    const report = computeReport([withFrom, event("2", "t-a", A, 101, "6")], 100, 150, terminals);
    expect(report.payments[0]!.fromHex).toBe(B);
    expect("fromHex" in report.payments[1]!).toBe(false);
  });

  it("yields an empty payments array for a zero-event period", () => {
    expect(computeReport([], 100, 150, terminals).payments).toEqual([]);
  });
});

// Z commit (now rail-combined) is covered in tests/close-out.test.ts.
