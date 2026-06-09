// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v1 durable persistence over the host KV. Append-heavy logs use an
 * index + per-item layout so each new payment is a bounded write. All keys are
 * scoped by the KvStore (`w3s-payment-processor:`).
 */
import type { KvStore } from "@/shared/utils/kv-store.ts";
import type { PaymentEvent, ReportPayment, ReportState, ZReportRecord } from "@/features/v1/types.ts";

const TXLOG_INDEX_KEY = "v1-txlog:index";
const CHECKPOINT_KEY = "v1-checkpoint";
const REPORT_STATE_KEY = "v1-report-state";
const ZREPORTS_INDEX_KEY = "v1-zreports:index";

export async function loadTxLog(kv: KvStore): Promise<PaymentEvent[]> {
  const ids = (await kv.getJSON<string[]>(TXLOG_INDEX_KEY)) ?? [];
  const items = await Promise.all(ids.map((id) => kv.getJSON<PaymentEvent>(`v1-txlog:item:${id}`)));
  return items.filter((event): event is PaymentEvent => event != null);
}

export async function loadTxLogIds(kv: KvStore): Promise<Set<string>> {
  return new Set((await kv.getJSON<string[]>(TXLOG_INDEX_KEY)) ?? []);
}

/**
 * Append already-deduped events: write each item, then extend the index once.
 * Items are written before the index so a crash mid-append never indexes an
 * id whose item is missing.
 */
export async function appendTxLog(kv: KvStore, events: readonly PaymentEvent[]): Promise<void> {
  if (events.length === 0) return;
  for (const event of events) {
    await kv.setJSON(`v1-txlog:item:${event.paymentId}`, event);
  }
  const ids = (await kv.getJSON<string[]>(TXLOG_INDEX_KEY)) ?? [];
  ids.push(...events.map((event) => event.paymentId));
  await kv.setJSON(TXLOG_INDEX_KEY, ids);
}

export async function setEventReconciled(kv: KvStore, paymentId: string, reconciled: boolean): Promise<void> {
  const event = await kv.getJSON<PaymentEvent>(`v1-txlog:item:${paymentId}`);
  if (!event) return;
  await kv.setJSON(`v1-txlog:item:${paymentId}`, { ...event, reconciled });
}

/** Last finalized block fully processed (the WS resume cursor). */
export async function loadCheckpoint(kv: KvStore): Promise<number | undefined> {
  return kv.getJSON<number>(CHECKPOINT_KEY);
}

export async function saveCheckpoint(kv: KvStore, blockNumber: number): Promise<void> {
  await kv.setJSON(CHECKPOINT_KEY, blockNumber);
}

export async function loadReportState(kv: KvStore): Promise<ReportState | undefined> {
  return kv.getJSON<ReportState>(REPORT_STATE_KEY);
}

export async function saveReportState(kv: KvStore, state: ReportState): Promise<void> {
  await kv.setJSON(REPORT_STATE_KEY, state);
}

export async function loadZReports(kv: KvStore): Promise<ZReportRecord[]> {
  const seqs = [...new Set((await kv.getJSON<number[]>(ZREPORTS_INDEX_KEY)) ?? [])];
  const items = await Promise.all(seqs.map((seq) => kv.getJSON<ZReportRecord>(`v1-zreports:item:${seq}`)));
  const records = items
    .filter((record): record is ZReportRecord => record != null)
    // Pre-feature records persisted before on-chain publish lacked a state.
    .map((record) => ({ ...record, publishState: record.publishState ?? "pending" }));

  const txLog = records.some((record) => record.payments == null && record.count > 0)
    ? await loadTxLog(kv)
    : [];

  return records.map((record) => ({
    ...record,
    payments: record.payments ?? reconstructPayments(record, txLog),
  }));
}

function reconstructPayments(record: ZReportRecord, txLog: readonly PaymentEvent[]): ReportPayment[] {
  if (record.count === 0) return [];
  const upper = record.toBlock >= record.fromBlock ? record.toBlock : Number.POSITIVE_INFINITY;
  const candidates = txLog
    .filter((event) => event.blockNumber >= record.fromBlock && event.blockNumber <= upper)
    .sort((a, b) => a.blockNumber - b.blockNumber || (a.paymentId < b.paymentId ? -1 : 1))
    .slice(0, record.count);
  if (candidates.length !== record.count) return [];
  let total = 0n;
  for (const event of candidates) total += BigInt(event.amountPlanck);
  if (total.toString() !== record.grandTotalPlanck) return [];
  return candidates.map((event) => ({
    paymentId: event.paymentId,
    terminalId: event.terminalId,
    amountPlanck: event.amountPlanck,
    blockNumber: event.blockNumber,
    observedAtMs: event.observedAtMs,
    ...(event.fromHex !== undefined ? { fromHex: event.fromHex } : {}),
  }));
}

export function clampPeriodStart(state: ReportState, zReports: readonly ZReportRecord[]): ReportState {
  let highestSwept = 0;
  for (const z of zReports) {
    if (z.toBlock >= z.fromBlock && z.toBlock > highestSwept) highestSwept = z.toBlock;
    for (const payment of z.payments) {
      if (payment.blockNumber != null && payment.blockNumber > highestSwept) {
        highestSwept = payment.blockNumber;
      }
    }
  }
  if (highestSwept === 0 || state.periodStartBlock > highestSwept) return state;
  return { ...state, periodStartBlock: highestSwept + 1 };
}

/**
 * Write (or overwrite by seq) a Z report and index its seq. Idempotent: a
 * re-persist of the same seq — e.g. to flip `publishState` after an on-chain
 * publish — rewrites the item without duplicating the index entry.
 */
export async function appendZReport(kv: KvStore, record: ZReportRecord): Promise<void> {
  await kv.setJSON(`v1-zreports:item:${record.seq}`, record);
  const seqs = (await kv.getJSON<number[]>(ZREPORTS_INDEX_KEY)) ?? [];
  if (!seqs.includes(record.seq)) {
    seqs.push(record.seq);
    await kv.setJSON(ZREPORTS_INDEX_KEY, seqs);
  }
}
