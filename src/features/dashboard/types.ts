// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import type { TerminalStatus, ZReportPublishState } from "@/features/v1/types.ts";

export interface StreamTerminal {
  id: string;
  name: string;
  address?: string;
  status?: TerminalStatus;
}

/**
 * Lifecycle of a payment as the UI shows it:
 *  - `detected`   — just landed in a best block, not yet final (gray)
 *  - `finalizing` — in the best chain, finality pending (blue)  [v2: claim pending]
 *  - `confirmed`  — finalized (green)                            [v2: claim settled]
 *  - `failed`     — v2 claim blocked/failed (red); v1 never fails
 */
export type PaymentLifecycle = "detected" | "finalizing" | "confirmed" | "failed";

/**
 * One row in the unified payment stream. Both monitor paths fold into this
 * single shape — the UI never splits "direct" vs "tap". `checkable` rows (v1)
 * carry the manual reconcile tick; v2 rows surface `attention` when a claim
 * has not settled. `status` drives the colored lifecycle pill; the detail
 * fields back the payment-detail sheet.
 */
export interface StreamPayment {
  id: string;
  terminalId: string;
  /** Token-unit amount (already converted from planck) for display + rollups. */
  amount: number;
  tsMs: number;
  source: "v1" | "v2";
  checkable: boolean;
  checked: boolean;
  attention: boolean;
  status: PaymentLifecycle;
  reference: string;
  blockNumber?: number;
  /** v1: 0x-AccountId32 of the payer, when decodable. */
  payerHex?: string;
  coinsCount?: number;
  claimNote?: string;
}

export interface TerminalTotal {
  amount: number;
  count: number;
}

export interface StreamTotals {
  perTill: Map<string, TerminalTotal>;
  grand: number;
  count: number;
}

export interface XReportStamp {
  asOfMs: number;
  count: number;
  total: number;
}

export interface ZHistoryPayment {
  id: string;
  tsMs: number;
  terminalId: string;
  amount: number;
  /** RFC-6 block; absent for coin payments. */
  blockNumber?: number;
}

export interface ZHistoryEntry {
  seq: number;
  closedAtMs: number;
  total: number;
  count: number;
  perTill: Map<string, number>;
  publishState: ZReportPublishState;
  cid?: string;
  /** Every payment swept by this close, oldest first — the browsable history. */
  payments: ZHistoryPayment[];
}
