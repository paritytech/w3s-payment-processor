// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Presentation-only formatting for the back-office UI. On-chain amounts are
 * integer planck; `toToken` converts at this one choke point (BigInt → number)
 * so the UI can render friendly money. Never used for fiscal math — the Z-report
 * engine keeps planck/BigInt end to end.
 */
import { formatPlanck } from "@/shared/utils/format.ts";

export function toToken(planck: string | bigint, decimals: number): number {
  const value = typeof planck === "bigint" ? planck : BigInt(planck || "0");
  return Number(formatPlanck(value, decimals));
}

export function fmtCash(n: number): string {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtInt(n: number): string {
  return Number(n).toLocaleString("en-US");
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

export function fmtHour(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:00 ${ap}`;
}

/** Day-qualified hour label for multi-day lists (e.g. "Jun 9 · 2:00 PM"). */
export function fmtDayHour(ms: number): string {
  const day = new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short" });
  return `${day} · ${fmtHour(ms)}`;
}

export function fmtDayTime(ms: number): string {
  const day = new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short" });
  return `${day}, ${fmtTime(ms)}`;
}

export function timeAgo(ms: number, nowMs: number = Date.now()): string {
  const mins = Math.round((nowMs - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m ago`;
}

export function tillColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return `oklch(0.62 0.09 ${hash})`;
}

export interface HourGroup<T> {
  hour: string;
  items: T[];
}

/**
 * Group a reverse-chronological list under hour headers, preserving order.
 * The list must already be sorted newest-first (or whatever order the caller
 * wants the buckets in) — grouping only coalesces adjacent same-hour items.
 */
export function groupByHour<T extends { tsMs: number }>(
  list: readonly T[],
  labelOf: (ms: number) => string = fmtHour,
): HourGroup<T>[] {
  const out: HourGroup<T>[] = [];
  let cur: HourGroup<T> | null = null;
  for (const item of list) {
    const hr = labelOf(item.tsMs);
    if (!cur || cur.hour !== hr) {
      cur = { hour: hr, items: [] };
      out.push(cur);
    }
    cur.items.push(item);
  }
  return out;
}
