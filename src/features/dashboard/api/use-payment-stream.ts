// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { envConfig } from "@/config.ts";
import { useProcessorConfig } from "@/shared/store/useProcessorConfig.tsx";
import { useV1Monitor } from "@/features/v1/store/V1MonitorProvider.tsx";
import { useV2Monitor } from "@/features/v2/store/V2MonitorProvider.tsx";
import { buildCombinedSnapshot, fiscalPeriodStartMs, performCloseOut } from "@/features/reports/api/close-out.ts";
import { createZReportPublisher } from "@/features/reports/api/zreport-publisher.ts";
import { resolveKvStore } from "@/shared/utils/kv-store.ts";
import { buildReportDoc, downloadReportDocCsv } from "@/features/reports/api/report-doc.ts";
import { loadSavedCreds } from "@/app/unlock-creds.ts";
import { fmtTime, toToken } from "@/shared/utils/ui-format.ts";
import type { ConnState } from "@/shared/components/indicators.tsx";
import type { Tone } from "@/shared/utils/tone.ts";
import type { HostAccountUiState, V2Status } from "@/features/v2/store/useV2Store.ts";
import type { V1CatchupProgress } from "@/features/v1/store/useV1Store.ts";
import { v2PaymentKey, type ClaimStatus } from "@/features/v2/types.ts";

import type { PaymentLifecycle, StreamPayment, StreamTerminal, StreamTotals, TerminalTotal, XReportStamp, ZHistoryEntry } from "@/features/dashboard/types.ts";

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


export function closeOutBlocker(args: {
  v1Enabled: boolean;
  v2Enabled: boolean;
  engineReady: boolean;
  finalizedBlock: number;
  fiscalHydrated: boolean;
  v2Status: V2Status;
}): string | null {
  if (!args.fiscalHydrated) {
    return "Saved reports are still loading — try again in a moment.";
  }
  if (args.v1Enabled) {
    if (!args.engineReady) {
      return "The payment monitor is still starting — try again once it's live.";
    }
    if (args.finalizedBlock === 0) {
      return "No blocks scanned yet this session — wait for the chain watch before closing out.";
    }
  }
  if (args.v2Enabled && args.v2Status !== "running") {
    return "The coin-payment monitor is still starting — try again once it's live.";
  }
  return null;
}

export interface StreamToast {
  msg: string;
  tone: Tone;
}

export interface PaymentStream {
  shop: { name: string; venue: string };
  terminals: StreamTerminal[];
  payments: StreamPayment[];
  /** Payments swept by past Zs (closed periods), full fidelity, newest first. */
  historyPayments: StreamPayment[];
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
  dismissToast: () => void;
  toggleCheck: (id: string) => void;
  checkAll: () => void;
  closeOut: () => void;
  publishReport: (seq: number) => Promise<void>;
  /** Recompute the fiscal X (open v1 period) and stamp it on the panel. */
  updateXReport: () => void;
  /** Last "Update" stamp; null until pressed, cleared on close-out. */
  xStamp: XReportStamp | null;
  /** Save the X period's payments as a CSV line-item export. */
  exportXReportCsv: () => void;
  /** Save committed Z report `seq`'s payments as a CSV line-item export. */
  downloadReportCsv: (seq: number) => void;
}

export function usePaymentStream(): PaymentStream {
  const config = useProcessorConfig();
  const v1 = useV1Monitor();
  const v2 = useV2Monitor();
  const decimals = envConfig.token.decimals;

  const [toast, setToast] = useState<StreamToast | null>(null);
  // Fiscal X stamp from the last "Update" press; cleared when a Z closes the period.
  const [xStamp, setXStamp] = useState<XReportStamp | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toastSource = useRef<"payment" | "other" | null>(null);
  const toastEpoch = useRef(0);
  const dismissToast = useCallback(() => {
    toastEpoch.current += 1;
    clearTimeout(timer.current);
    timer.current = undefined;
    toastSource.current = null;
    setToast(null);
  }, []);
  const flash = useCallback((msg: string, t: Tone = "neutral") => {
    const epoch = toastEpoch.current + 1;
    toastEpoch.current = epoch;
    clearTimeout(timer.current);
    toastSource.current = "other";
    setToast({ msg, tone: t });
    timer.current = setTimeout(() => {
      timer.current = undefined;
      toastSource.current = null;
      if (toastEpoch.current === epoch) setToast(null);
    }, 2600);
  }, []);
  const flashPayment = useCallback((msg: string) => {
    if (timer.current !== undefined && toastSource.current === "payment") {
      setToast({ msg, tone: "blue" });
      return;
    }
    const epoch = toastEpoch.current + 1;
    toastEpoch.current = epoch;
    clearTimeout(timer.current);
    toastSource.current = "payment";
    setToast({ msg, tone: "blue" });
    timer.current = setTimeout(() => {
      timer.current = undefined;
      toastSource.current = null;
      if (toastEpoch.current === epoch) setToast(null);
    }, 2600);
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

  // "New payment detected" toast — reacts only to detections that arrive
  // after mount. Track the stable payment key, not the event object: duplicate
  // monitor callbacks can write a fresh `lastDetection` object for the same
  // payment. During a burst, update the message without extending the current
  // timeout; otherwise continuous payments can keep the toast alive forever.
  const seenDetectionKey = useRef(v2.lastDetection?.key);
  useEffect(() => {
    const det = v2.lastDetection;
    if (!det || det.key === seenDetectionKey.current) return;
    seenDetectionKey.current = det.key;
    const till = terminals.find((t) => t.id === det.terminalId);
    flashPayment(`New payment detected — ${det.amount} ${envConfig.token.symbol} (${till?.name ?? det.terminalId})`);
  }, [v2.lastDetection, terminals, flashPayment]);
  const periodStartBlock = v1.reportState.periodStartBlock;
  const scannedBlock = v1.finalizedBlock;
  const confirmedBlock = v1.confirmedBlock;

  const periodStartMs = useMemo(() => fiscalPeriodStartMs(v1.zReports), [v1.zReports]);
  const { payments, historyPayments } = useMemo(() => {
    const open: StreamPayment[] = [];
    const closed: StreamPayment[] = [];
    for (const e of v1.events) {
      const inPeriod = e.blockNumber >= periodStartBlock;
      (inPeriod ? open : closed).push({
        id: `v1:${e.paymentId}`,
        terminalId: e.terminalId,
        amount: toToken(e.amountPlanck, decimals),
        tsMs: e.observedAtMs,
        source: "v1",
        checkable: true,
        checked: e.reconciled,
        attention: false,
        // Swept payments are final by definition (a committed Z closed over
        // them) — don't re-derive from this session's scan heads, which start
        // at 0 and would misreport old blocks as "finalizing".
        status: inPeriod ? v1Lifecycle(e.blockNumber, scannedBlock, confirmedBlock) : "confirmed",
        reference: e.paymentId,
        blockNumber: e.blockNumber,
        payerHex: e.fromHex,
      });
    }
    for (const r of v2.records) {
      const inPeriod = r.firstSeenAtMs > periodStartMs; // at/before = closed by a previous Z
      (inPeriod ? open : closed).push({
        id: `v2:${v2PaymentKey(r.topicHex, r.id, r.timestampMs)}`,
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
    open.sort((a, b) => b.tsMs - a.tsMs);
    closed.sort((a, b) => b.tsMs - a.tsMs);
    return { payments: open, historyPayments: closed };
  }, [v1.events, v2.records, periodStartBlock, periodStartMs, decimals, scannedBlock, confirmedBlock]);

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
          payments: z.payments.map((p) => ({
            id: p.paymentId,
            tsMs: p.observedAtMs,
            terminalId: p.terminalId,
            amount: toToken(p.amountPlanck, decimals),
            ...(p.blockNumber != null ? { blockNumber: p.blockNumber } : {}),
          })),
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

  // One publisher instance backs both the post-close auto-publish and the
  // manual row button (it was engine-owned before close-out went rail-neutral).
  const publishZ = useMemo(() => createZReportPublisher(resolveKvStore()), []);

  const closeOut = useCallback(() => {
    const blocker = closeOutBlocker({
      v1Enabled: config.v1.enabled,
      v2Enabled: config.v2.enabled,
      engineReady: v1.engineReady,
      finalizedBlock: v1.finalizedBlock,
      fiscalHydrated: v1.fiscalHydrated,
      v2Status: v2.status,
    });
    if (blocker != null) {
      flash(blocker, "red");
      return;
    }
    performCloseOut(config.v2.terminals).then(
      (record) => {
        setXStamp(null); // the stamp described the period that just closed
        flash("Day closed out — new period started", "green");
        // Best-effort auto-publish (previously the engine's job on commit);
        // a failure leaves the row `pending` for the manual publish button.
        void publishZ(record.seq).catch((error) => {
          console.warn(`[reports] auto-publish seq ${record.seq} failed`, error);
          flash(
            `Closed out, but publishing report Z·${String(record.seq).padStart(4, "0")} failed — ` +
              "use Publish on the report row to retry.",
            "red",
          );
        });
      },
      (error) => flash(error instanceof Error ? error.message : "Close out failed", "red"),
    );
  }, [config.v1.enabled, config.v2.enabled, config.v2.terminals, v1, v2.status, flash, publishZ]);

  const publishReport = useCallback(
    (seq: number): Promise<void> =>
      publishZ(seq).then(
        (published) =>
          flash(
            published.seq === seq
              ? `Report Z·${String(seq).padStart(4, "0")} published on-chain`
              : `Slot Z·${String(seq).padStart(4, "0")} was taken — report published on-chain as Z·${String(published.seq).padStart(4, "0")}`,
            "green",
          ),
        (error) => flash(error instanceof Error ? error.message : "Publish failed", "red"),
      ),
    [publishZ, flash],
  );

  // The X view = the open fiscal period across BOTH rails — exactly what the
  // next Z will close: RFC-6 credits by block window, coin payments since
  // the last Z's commit time.
  const buildXSnapshot = useCallback(
    () =>
      buildCombinedSnapshot({
        v1Events: v1.events,
        periodStartBlock: v1.reportState.periodStartBlock,
        finalizedBlock: v1.finalizedBlock,
        v1Terminals: v1.terminals,
        v2Records: v2.records,
        v2Terminals: config.v2.terminals,
        periodStartMs,
        nowMs: Date.now(),
      }).snapshot,
    [v1, v2.records, config.v2.terminals, periodStartMs],
  );

  const updateXReport = useCallback(() => {
    const snapshot = buildXSnapshot();
    setXStamp({ asOfMs: Date.now(), count: snapshot.count, total: toToken(snapshot.grandTotalPlanck, decimals) });
    flash(`X updated — ${snapshot.count} payment${snapshot.count === 1 ? "" : "s"} this period`, "green");
  }, [buildXSnapshot, decimals, flash]);

  const exportXReportCsv = useCallback(() => {
    downloadReportDocCsv(
      buildReportDoc({ kind: "x", groupId: loadSavedCreds().groupId, snapshot: buildXSnapshot(), generatedAtMs: Date.now() }),
    );
    flash("X report exported (CSV)", "green");
  }, [buildXSnapshot, flash]);

  const downloadReportCsv = useCallback(
    (seq: number) => {
      const record = v1.zReports.find((z) => z.seq === seq);
      if (!record) return;
      downloadReportDocCsv(
        buildReportDoc({
          kind: "z",
          groupId: loadSavedCreds().groupId,
          snapshot: record,
          seq: record.seq,
          generatedAtMs: record.committedAtMs,
        }),
      );
      flash(`Report Z·${String(seq).padStart(4, "0")} exported (CSV)`, "green");
    },
    [v1.zReports, flash],
  );

  return {
    shop: { name: config.profile.merchantName, venue: config.profile.merchantId },
    terminals,
    payments,
    historyPayments,
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
    dismissToast,
    closeOut,
    publishReport,
    updateXReport,
    xStamp,
    exportXReportCsv,
    downloadReportCsv,
  };
}
