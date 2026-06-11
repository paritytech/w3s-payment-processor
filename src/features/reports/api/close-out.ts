// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech


import type { ResolvedV2Terminal } from "@/config.ts"
import { computeReport } from "@/features/v1/api/reports.ts";
import { appendZReport, saveReportState } from "@/features/v1/api/persistence.ts";
import type {
  PaymentEvent,
  ReportLine,
  ReportPayment,
  ReportSnapshot,
  ReportState,
  V1Terminal,
  ZReportRecord,
} from "@/features/v1/types.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";
import type { PaymentRecord } from "@/features/v2/types.ts";
import { useV2Store } from "@/features/v2/store/useV2Store.ts";
import { resolveKvStore } from "@/shared/utils/kv-store.ts";

export interface CombinedPeriodInputs {
  v1Events: readonly PaymentEvent[];
  periodStartBlock: number;
  finalizedBlock: number;
  v1Terminals: readonly V1Terminal[];
  v2Records: readonly PaymentRecord[];
  /** Resolved config terminals — source of per-terminal payout hex for coin lines. */
  v2Terminals: readonly ResolvedV2Terminal[];
  /** Wall-clock start of the open coin-payment period (last Z commit, 0 when none). */
  periodStartMs: number;
  nowMs: number;
}

/** The open coin-payment period starts where the last Z closed (0 = all history). */
export function fiscalPeriodStartMs(zReports: readonly ZReportRecord[]): number {
  let latest = 0;
  for (const z of zReports) if (z.committedAtMs > latest) latest = z.committedAtMs;
  return latest;
}

export interface CombinedSnapshot {
  snapshot: ReportSnapshot;
  v1Count: number;
  v2Count: number;
}

/**
 * Compute the open period across both rails — the X view, and the body of the
 * next Z. Pure.
 */
export function buildCombinedSnapshot(inputs: CombinedPeriodInputs): CombinedSnapshot {
  const v1 = computeReport(inputs.v1Events, inputs.periodStartBlock, inputs.finalizedBlock, inputs.v1Terminals);

  // Claim status is operational, not fiscal — blocked/failed coin payments
  // still count (the customer paid; recovery is the merchant's problem).
  // `duplicate` records are the one exception: a refused re-tap of a settled
  // sale moved no money, so they never enter totals or Z line items.
  const v2Payments: ReportPayment[] = inputs.v2Records
    .filter((r) => r.claimStatus !== "duplicate" && r.firstSeenAtMs > inputs.periodStartMs && r.firstSeenAtMs <= inputs.nowMs)
    .map((r) => ({
      paymentId: r.id,
      terminalId: r.terminalId,
      amountPlanck: r.amountPlanck,
      observedAtMs: r.firstSeenAtMs,
    }))
    .sort((a, b) => a.observedAtMs - b.observedAtMs || (a.paymentId < b.paymentId ? -1 : 1));

  // Merge per-terminal rollups. A till configured on both rails contributes
  // one line; coin-only tills resolve their payout from the v2 config.
  const payoutByTerminal = new Map(inputs.v2Terminals.map((t) => [t.terminalId, t.payout.hex]));
  const lineByTerminal = new Map<string, ReportLine>(v1.lines.map((line) => [line.terminalId, { ...line }]));
  let grandTotal = BigInt(v1.grandTotalPlanck);
  for (const payment of v2Payments) {
    let line = lineByTerminal.get(payment.terminalId);
    if (!line) {
      line = {
        terminalId: payment.terminalId,
        payoutHex: payoutByTerminal.get(payment.terminalId) ?? "",
        totalPlanck: "0",
        count: 0,
      };
      lineByTerminal.set(payment.terminalId, line);
    }
    line.totalPlanck = (BigInt(line.totalPlanck) + BigInt(payment.amountPlanck)).toString();
    line.count += 1;
    grandTotal += BigInt(payment.amountPlanck);
  }

  return {
    snapshot: {
      fromBlock: v1.fromBlock,
      toBlock: v1.toBlock,
      lines: [...lineByTerminal.values()],
      grandTotalPlanck: grandTotal.toString(),
      count: v1.count + v2Payments.length,
      payments: [...v1.payments, ...v2Payments],
    },
    v1Count: v1.count,
    v2Count: v2Payments.length,
  };
}

export interface CommittedZReport {
  record: ZReportRecord;
  nextState: ReportState;
}

/**
 * Commit a Z over the open period: assign the next seq and advance both
 * period cursors. Pure — the caller persists `record` + `nextState`.
 */
export function commitCombinedZReport(inputs: CombinedPeriodInputs, lastZSeq: number): CommittedZReport {
  const { snapshot, v1Count, v2Count } = buildCombinedSnapshot(inputs);
  const seq = lastZSeq + 1;
  const source = v1Count > 0 && v2Count > 0 ? "mixed" : v2Count > 0 ? "v2" : "v1";
  return {
    record: { ...snapshot, seq, committedAtMs: inputs.nowMs, source, publishState: "pending" },
    nextState: {
      // Advance the block cursor past the last scanned block. When the chain
      // watch never ran this session (v2-only setups), leave it untouched so
      // a later v1 enablement still seeds from its first scanned block.
      periodStartBlock: inputs.finalizedBlock > 0 ? inputs.finalizedBlock + 1 : inputs.periodStartBlock,
      lastZSeq: seq,
    },
  };
}

/**
 * Close out the open period: read both monitors' live state, commit the
 * combined Z, persist it, and publish it into the fiscal store. The caller
 * gates readiness (`closeOutBlocker`) and owns the on-chain publish attempt.
 */
export async function performCloseOut(v2Terminals: readonly ResolvedV2Terminal[]): Promise<ZReportRecord> {
  const kv = resolveKvStore();
  const v1State = useV1Store.getState();
  const v2State = useV2Store.getState();
  const { record, nextState } = commitCombinedZReport(
    {
      v1Events: v1State.events,
      periodStartBlock: v1State.reportState.periodStartBlock,
      finalizedBlock: v1State.finalizedBlock,
      v1Terminals: v1State.terminals,
      v2Records: v2State.records,
      v2Terminals,
      periodStartMs: fiscalPeriodStartMs(v1State.zReports),
      nowMs: Date.now(),
    },
    v1State.reportState.lastZSeq,
  );
  await appendZReport(kv, record);
  await saveReportState(kv, nextState);
  const current = useV1Store.getState();
  useV1Store.setState({ zReports: [...current.zReports, record], reportState: nextState });
  return record;
}
