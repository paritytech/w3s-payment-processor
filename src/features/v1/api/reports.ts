// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import type {
  PaymentEvent,
  ReportLine,
  ReportSnapshot,
  ReportState,
  V1Terminal,
  ZReportRecord,
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
  }

  const lines: ReportLine[] = [...totals.values()].map((line) => ({
    terminalId: line.terminalId,
    payoutHex: line.payoutHex,
    totalPlanck: line.total.toString(),
    count: line.count,
  }));
  return { fromBlock, toBlock, lines, grandTotalPlanck: grandTotal.toString(), count };
}

export interface CommittedZReport {
  record: ZReportRecord;
  nextState: ReportState;
}

/**
 * Commit a Z report (RFC6 fiscal close) over `[state.periodStartBlock,
 * toBlock]`, assign the next sequence, and advance the open period to
 * `toBlock + 1`. Pure: the caller persists `record` + `nextState`.
 */
export function commitZReport(
  state: ReportState,
  events: readonly PaymentEvent[],
  toBlock: number,
  terminals: readonly V1Terminal[],
  nowMs: number,
): CommittedZReport {
  const snapshot = computeReport(events, state.periodStartBlock, toBlock, terminals);
  const seq = state.lastZSeq + 1;
  return {
    record: { ...snapshot, seq, committedAtMs: nowMs, source: "v1", publishState: "pending" },
    nextState: { periodStartBlock: toBlock + 1, lastZSeq: seq },
  };
}
