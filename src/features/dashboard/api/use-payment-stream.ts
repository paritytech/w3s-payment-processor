// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { useCallback, useMemo, useRef, useState } from "react";

import { envConfig } from "@/config.ts";
import { useProcessorConfig } from "@/shared/store/useProcessorConfig.tsx";
import { useV1Monitor } from "@/features/v1/store/V1MonitorProvider.tsx";
import { useV2Monitor } from "@/features/v2/store/V2MonitorProvider.tsx";
import { fmtTime, toToken } from "@/shared/utils/ui-format.ts";
import type { ConnState } from "@/shared/components/indicators.tsx";
import type { Tone } from "@/shared/utils/tone.ts";
import type { HostAccountUiState } from "@/features/v2/store/useV2Store.ts";
import type { V1CatchupProgress } from "@/features/v1/store/useV1Store.ts";
import type { ClaimStatus } from "@/features/v2/types.ts";

import type { PaymentLifecycle, StreamPayment, StreamTerminal, StreamTotals, TerminalTotal, ZHistoryEntry } from "@/features/dashboard/types.ts";

/**
 * v1 lifecycle from block depth: confirmed once finalized, detected at the very
 * tip (just landed), finalizing in between (best chain, finality pending).
 */
function v1Lifecycle(blockNumber: number, scannedHead: number, confirmedHead: number): PaymentLifecycle {
  if (confirmedHead > 0 && blockNumber <= confirmedHead) return "confirmed";
  if (blockNumber >= scannedHead) return "detected";
  return "finalizing";
}

/** v2 lifecycle from claim outcome (statement payments are already final on arrival). */
function v2Lifecycle(claimStatus: ClaimStatus): PaymentLifecycle {
  if (claimStatus === "claimed") return "confirmed";
  if (claimStatus === "pending") return "finalizing";
  return "failed";
}

export interface StreamToast {
  msg: string;
  tone: Tone;
}

export interface PaymentStream {
  shop: { name: string; venue: string };
  terminals: StreamTerminal[];
  payments: StreamPayment[];
  totals: StreamTotals;
  unchecked: number;
  hasData: boolean;
  hasLoaded: boolean;
  conn: ConnState;
  connError?: string;
  catchupProgress: V1CatchupProgress | null;
  /** Present only during catchup — jump the scan to the chain head (skips the unscanned range). */
  skipCatchup?: () => void;
  connWarn?: string;
  /** Set only when v2 is enabled but claims are disabled — the load-bearing "you're not collecting" signal. */
  claimsNotice?: string;
  hostAccount: HostAccountUiState;
  requestHostLogin?: () => Promise<void>;
  zHistory: ZHistoryEntry[];
  periodLabel: string;
  toast: StreamToast | null;
  toggleCheck: (id: string) => void;
  checkAll: () => void;
  closeOut: () => void;
  publishReport: (seq: number) => Promise<void>;
}

export function usePaymentStream(): PaymentStream {
  const config = useProcessorConfig();
  const v1 = useV1Monitor();
  const v2 = useV2Monitor();
  const decimals = envConfig.token.decimals;

  const [toast, setToast] = useState<StreamToast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flash = useCallback((msg: string, t: Tone = "neutral") => {
    setToast({ msg, tone: t });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const terminals = useMemo<StreamTerminal[]>(() => {
    const seen = new Set<string>();
    const out: StreamTerminal[] = [];
    for (const t of v1.terminals) {
      if (seen.has(t.terminalId)) continue;
      seen.add(t.terminalId);
      out.push({ id: t.terminalId, name: t.displayName || t.terminalId, address: t.payout.ss58, status: t.status });
    }
    for (const t of config.v2.terminals) {
      if (seen.has(t.terminalId)) continue;
      seen.add(t.terminalId);
      out.push({ id: t.terminalId, name: t.label ?? t.terminalId, address: t.payout.ss58 });
    }
    return out;
  }, [v1.terminals, config.v2.terminals]);

  const periodStartBlock = v1.reportState.periodStartBlock;
  const scannedBlock = v1.finalizedBlock;
  const confirmedBlock = v1.confirmedBlock;
  const payments = useMemo<StreamPayment[]>(() => {
    const out: StreamPayment[] = [];
    for (const e of v1.events) {
      if (e.blockNumber < periodStartBlock) continue;
      out.push({
        id: `v1:${e.paymentId}`,
        terminalId: e.terminalId,
        amount: toToken(e.amountPlanck, decimals),
        tsMs: e.observedAtMs,
        source: "v1",
        checkable: true,
        checked: e.reconciled,
        attention: false,
        status: v1Lifecycle(e.blockNumber, scannedBlock, confirmedBlock),
        reference: e.paymentId,
        blockNumber: e.blockNumber,
        payerHex: e.fromHex,
      });
    }
    for (const r of v2.records) {
      out.push({
        id: `v2:${r.id}`,
        terminalId: r.terminalId,
        amount: toToken(r.amountPlanck, decimals),
        tsMs: r.firstSeenAtMs,
        source: "v2",
        checkable: false,
        checked: false,
        attention: r.claimStatus !== "claimed",
        status: v2Lifecycle(r.claimStatus),
        reference: r.id,
        coinsCount: r.coinsCount,
        claimNote: r.claimDiagnostic,
      });
    }
    out.sort((a, b) => b.tsMs - a.tsMs);
    return out;
  }, [v1.events, v2.records, periodStartBlock, decimals, scannedBlock, confirmedBlock]);

  const totals = useMemo<StreamTotals>(() => {
    const perTill = new Map<string, TerminalTotal>();
    for (const t of terminals) perTill.set(t.id, { amount: 0, count: 0 });
    let grand = 0;
    let count = 0;
    for (const p of payments) {
      let cell = perTill.get(p.terminalId);
      if (!cell) {
        cell = { amount: 0, count: 0 };
        perTill.set(p.terminalId, cell);
      }
      cell.amount += p.amount;
      cell.count += 1;
      grand += p.amount;
      count += 1;
    }
    return { perTill, grand, count };
  }, [payments, terminals]);

  const unchecked = useMemo(() => payments.filter((p) => p.checkable && !p.checked).length, [payments]);

  const zHistory = useMemo<ZHistoryEntry[]>(
    () =>
      v1.zReports
        .map((z) => ({
          seq: z.seq,
          closedAtMs: z.committedAtMs,
          total: toToken(z.grandTotalPlanck, decimals),
          count: z.count,
          perTill: new Map(z.lines.map((l) => [l.terminalId, toToken(l.totalPlanck, decimals)])),
          publishState: z.publishState,
          cid: z.cid,
        }))
        .sort((a, b) => b.seq - a.seq),
    [v1.zReports, decimals],
  );

  const periodLabel = useMemo(
    () => (payments.length === 0 ? "this period" : `since ${fmtTime(payments[payments.length - 1]!.tsMs)}`),
    [payments],
  );

  const statuses: string[] = [];
  if (config.v1.enabled) statuses.push(v1.status);
  if (config.v2.enabled) statuses.push(v2.status);
  const conn: ConnState = statuses.some((s) => s === "error")
    ? "problem"
    : v1.catchupProgress
      ? "syncing"
      : statuses.some((s) => s === "resolving" || s === "idle")
        ? "connecting"
        : "live";
  const hasLoaded = terminals.length > 0 || payments.length > 0 || v1.finalizedBlock > 0 || v2.records.length > 0 || conn === "live";


  const toggleCheck = useCallback(
    (id: string) => {
      if (id.startsWith("v1:")) void v1.toggleReconcile(id.slice(3));
    },
    [v1],
  );

  const checkAll = useCallback(() => {
    const ids = payments.filter((p) => p.checkable && !p.checked).map((p) => p.id.slice(3));
    if (ids.length === 0) return;
    void Promise.all(ids.map((pid) => v1.toggleReconcile(pid))).then(() => flash("All payments checked off", "green"));
  }, [payments, v1, flash]);

  const closeOut = useCallback(() => {
    void v1.commitZReport().then(() => flash("Day closed out — new period started", "green"));
  }, [v1, flash]);

  const publishReport = useCallback(
    (seq: number): Promise<void> =>
      v1.publishZReport(seq).then(
        () => flash(`Report Z·${String(seq).padStart(4, "0")} published on-chain`, "green"),
        (error) => flash(error instanceof Error ? error.message : "Publish failed", "red"),
      ),
    [v1, flash],
  );

  return {
    shop: { name: config.profile.merchantName, venue: config.profile.merchantId },
    terminals,
    payments,
    totals,
    unchecked,
    hasData: payments.length > 0,
    hasLoaded,
    conn,
    connError: v1.error || v2.error,
    connWarn: v1.warn,
    catchupProgress: v1.catchupProgress,
    skipCatchup: v1.requestSkipToHead,
    claimsNotice: config.v2.enabled && !v2.claimsEnabled ? v2.notice : undefined,
    hostAccount: v2.hostAccount,
    requestHostLogin: v2.requestHostLogin,
    zHistory,
    periodLabel,
    toast,
    toggleCheck,
    checkAll,
    closeOut,
    publishReport,
  };
}
