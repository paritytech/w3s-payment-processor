// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech


import { envConfig } from "@/config.ts";
import type { ReportLine, ReportPayment, ReportSnapshot } from "@/features/v1/types.ts";
import { formatPlanck } from "@/shared/utils/format.ts";

export const PROCESSOR_REPORT_FORMAT = "w3s-processor-report";
export const PROCESSOR_REPORT_VERSION = 1;

export interface ProcessorReportDoc {
  format: "w3s-processor-report";
  version: 1;
  kind: "x" | "z";
  groupId: string;
  /** Display metadata so the admin can format amounts without the config bundle. */
  token: { symbol: string; decimals: number };
  /** Z: committedAtMs (keeps publish retries byte-identical). X: Date.now() at build. */
  generatedAtMs: number;
  /** Z only; omitted for X. */
  seq?: number;
  fromBlock: number;
  toBlock: number;
  /** Per-terminal rollup. */
  lines: ReportLine[];
  grandTotalPlanck: string;
  count: number;
  /** Each line item = one payment. Sorted by blockNumber asc, then paymentId asc. */
  payments: ReportPayment[];
}

export interface BuildReportDocArgs {
  kind: "x" | "z";
  groupId: string;
  /** A `ZReportRecord` is assignable; only the snapshot fields are copied. */
  snapshot: ReportSnapshot;
  generatedAtMs: number;
  seq?: number;
}


export function buildReportDoc(args: BuildReportDocArgs): ProcessorReportDoc {
  const { snapshot } = args;
  return {
    format: PROCESSOR_REPORT_FORMAT,
    version: PROCESSOR_REPORT_VERSION,
    kind: args.kind,
    groupId: args.groupId,
    token: { symbol: envConfig.token.symbol, decimals: envConfig.token.decimals },
    generatedAtMs: args.generatedAtMs,
    ...(args.kind === "z" && args.seq !== undefined ? { seq: args.seq } : {}),
    fromBlock: snapshot.fromBlock,
    toBlock: snapshot.toBlock,
    lines: snapshot.lines,
    grandTotalPlanck: snapshot.grandTotalPlanck,
    count: snapshot.count,
    payments: snapshot.payments,
  };
}

/** `w3spay-z-report-0007` / `w3spay-x-report-2026-06-09T14-30` (minute-stamped). */
function reportDocBaseName(doc: ProcessorReportDoc): string {
  return doc.kind === "z"
    ? `w3spay-z-report-${String(doc.seq).padStart(4, "0")}`
    : `w3spay-x-report-${new Date(doc.generatedAtMs).toISOString().slice(0, 16).replace(":", "-")}`;
}

function saveAs(filename: string, mime: string, content: string): void {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (caught) {
    console.warn("[reports] download failed", caught);
  }
}

function escCsv(value: string): string {
  return value.includes(",") || value.includes('"') || value.includes("\n")
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

export function reportDocToCsv(doc: ProcessorReportDoc): string {
  const header = "payment_id,terminal_id,amount,token,amount_planck,block_number,observed_at,payer";
  const rows = doc.payments.map((p) =>
    [
      p.paymentId,
      p.terminalId,
      formatPlanck(BigInt(p.amountPlanck), doc.token.decimals),
      doc.token.symbol,
      p.amountPlanck,
      p.blockNumber != null ? String(p.blockNumber) : "",
      new Date(p.observedAtMs).toISOString(),
      p.fromHex ?? "",
    ]
      .map(escCsv)
      .join(","),
  );
  return [header, ...rows].join("\n");
}

/** Save a report doc's payments as a local CSV file (browser download). */
export function downloadReportDocCsv(doc: ProcessorReportDoc): void {
  saveAs(`${reportDocBaseName(doc)}.csv`, "text/csv", reportDocToCsv(doc));
}
