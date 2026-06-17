/**
 * Display rollup for the dashboard running total. The load-bearing rule: a
 * failed v2 claim is shown in the stream but is NOT money taken, so it must
 * never be summed into the running total, per-till subtotals, or count. (The
 * fiscal X/Z close-out counts failed claims on purpose — that path is
 * `buildCombinedSnapshot`, covered by close-out.test.ts.)
 */
import { describe, expect, it } from "vitest";

import { computeStreamTotals } from "@/features/dashboard/api/stream-totals.ts";
import type { PaymentLifecycle, StreamPayment, StreamTerminal } from "@/features/dashboard/types.ts";

let seq = 0;
function pay(amount: number, status: PaymentLifecycle, terminalId = "till-1"): StreamPayment {
  seq += 1;
  return {
    id: `p${seq}`,
    terminalId,
    amount,
    tsMs: seq,
    source: "v2",
    checkable: false,
    checked: false,
    attention: status === "failed",
    status,
    reference: `r${seq}`,
  };
}

function till(id: string): StreamTerminal {
  return { id, name: id };
}

describe("computeStreamTotals", () => {
  it("excludes a failed sale from the grand total (the reported bug: $11 + $20 + failed $9 = $31, not $40)", () => {
    const totals = computeStreamTotals(
      [pay(11, "confirmed"), pay(20, "confirmed"), pay(9, "failed")],
      [till("till-1")],
    );
    expect(totals.grand).toBe(31);
    expect(totals.count).toBe(2);
    expect(totals.perTill.get("till-1")).toEqual({ amount: 31, count: 2 });
  });

  it("counts every non-failed lifecycle (detected/finalizing/confirmed all real money in flight)", () => {
    const totals = computeStreamTotals(
      [pay(5, "detected"), pay(7, "finalizing"), pay(13, "confirmed"), pay(100, "failed")],
      [till("till-1")],
    );
    expect(totals.grand).toBe(25);
    expect(totals.count).toBe(3);
  });

  it("drops failed amounts per terminal, not just from the grand total", () => {
    const totals = computeStreamTotals(
      [
        pay(40, "confirmed", "till-a"),
        pay(9, "failed", "till-a"),
        pay(15, "confirmed", "till-b"),
      ],
      [till("till-a"), till("till-b")],
    );
    expect(totals.perTill.get("till-a")).toEqual({ amount: 40, count: 1 });
    expect(totals.perTill.get("till-b")).toEqual({ amount: 15, count: 1 });
    expect(totals.grand).toBe(55);
  });

  it("leaves a terminal whose only payment failed at zero (seeded, not dropped)", () => {
    const totals = computeStreamTotals([pay(9, "failed", "till-1")], [till("till-1")]);
    expect(totals.perTill.get("till-1")).toEqual({ amount: 0, count: 0 });
    expect(totals.grand).toBe(0);
    expect(totals.count).toBe(0);
  });
});
