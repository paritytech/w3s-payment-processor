// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import type {
  PaymentEvent,
  ReportLine,
  ReportPayment,
  ReportSnapshot,
  V1Terminal,
} from "@/features/v1/types.ts";

/**
 * Roll up payment events over a block-number period `[fromBlock, toBlock]`.
 *
 * Used for BOTH the interim **X report** (current open period, no state change)
 * and as the body of a **Z report** (fiscal close). Every configured terminal
 * gets a line — including zero-activity terminals — so the report is a complete
 * fiscal record, not just the terminals that happened to transact.
 */
export function computeReport(
  events: readonly PaymentEvent[],
  fromBlock: number,
  toBlock: number,
  terminals: readonly V1Terminal[],
): ReportSnapshot {
  const totals = new Map<string, { terminalId: string; payoutHex: string; total: bigint; count: number }>();
  for (const terminal of terminals) {
    totals.set(terminal.terminalId, { terminalId: terminal.terminalId, payoutHex: terminal.payout.hex, total: 0n, count: 0 });
  }

  let grandTotal = 0n;
  let count = 0;
  const payments: ReportPayment[] = [];
  for (const event of events) {
    if (event.blockNumber < fromBlock || event.blockNumber > toBlock) continue;
    let line = totals.get(event.terminalId);
    if (!line) {
      // A terminal seen on-chain but not in the current config (e.g. it was
      // removed since). Keep it in the report so funds are never hidden.
      line = { terminalId: event.terminalId, payoutHex: event.payoutHex, total: 0n, count: 0 };
      totals.set(event.terminalId, line);
    }
    const amount = BigInt(event.amountPlanck);
    line.total += amount;
    line.count += 1;
    grandTotal += amount;
    count += 1;
    payments.push({
      paymentId: event.paymentId,
      terminalId: event.terminalId,
      amountPlanck: event.amountPlanck,
      blockNumber: event.blockNumber,
      observedAtMs: event.observedAtMs,
      ...(event.fromHex !== undefined ? { fromHex: event.fromHex } : {}),
    });
  }
  payments.sort((a, b) => (a.blockNumber ?? 0) - (b.blockNumber ?? 0) || (a.paymentId < b.paymentId ? -1 : 1));

  const lines: ReportLine[] = [...totals.values()].map((line) => ({
    terminalId: line.terminalId,
    payoutHex: line.payoutHex,
    totalPlanck: line.total.toString(),
    count: line.count,
  }));
  return { fromBlock, toBlock, lines, grandTotalPlanck: grandTotal.toString(), count, payments };
}