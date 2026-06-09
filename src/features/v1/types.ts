// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import type { ResolvedPayout } from "@/config.ts"

/** Lifecycle status as carried by the on-chain registry. */
export type TerminalStatus = "active" | "paused" | "revoked";

/**
 * A terminal the v1 monitor watches. Either synthesized from local config or
 * read from the on-chain registry (filtered by groupId). `displayName`/`status`
 * are only present for registry-sourced terminals.
 */
export interface V1Terminal {
  terminalId: string;
  payout: ResolvedPayout;
  displayName?: string;
  status?: TerminalStatus;
}

/** Which on-chain event surfaced a credit. A Coinage offboard emits both. */
export type CreditSource = "assets-transferred" | "coinage-unloaded" | "coinage-unloaded-vouchers";

/**
 * An observed credit to a terminal payout account — either an `Assets.Transferred`
 * of the configured token, or a `Coinage.RecyclerUnloadedIntoExternalAsset[AndVouchers]`
 * unload to the payout. Amounts are stored as decimal strings (bigint is not
 * JSON-serializable) and re-parsed for arithmetic.
 */
export interface PaymentEvent {
  /**
   * Stable dedupe id, `${blockHash}:x${extrinsicIndex}:${payoutHex}` (or
   * `:e${eventIndex}:` when not in an extrinsic phase). Keyed at the
   * extrinsic+payout grain because a single offboard emits BOTH a Coinage
   * unload event AND its inner Assets.Transferred — an event-index key would
   * double-count the same credit.
   */
  paymentId: string;
  blockNumber: number;
  blockHash: string;
  eventIndex: number;
  extrinsicIndex?: number;
  /** Which event matched (audit/debug; the same credit may surface via several). */
  source: CreditSource;
  terminalId: string;
  /** 0x-AccountId32 of the matched terminal payout. */
  payoutHex: string;
  /** 0x-AccountId32 of the payer, when decodable (Assets.Transferred only). */
  fromHex?: string;
  /** Transferred amount in integer planck, as a decimal string. */
  amountPlanck: string;
  observedAtMs: number;
  reconciled: boolean;
}

export interface ReportLine {
  terminalId: string;
  payoutHex: string;
  /** Sum of credits to this terminal in the period, integer planck as string. */
  totalPlanck: string;
  count: number;
}

export interface ReportPayment {
  paymentId: string;
  terminalId: string;
  amountPlanck: string;
  blockNumber?: number;
  observedAtMs: number;
  fromHex?: string;
}

/** A point-in-time rollup over a block-number period. X reports are interim. */
export interface ReportSnapshot {
  fromBlock: number;
  toBlock: number;
  lines: ReportLine[];
  grandTotalPlanck: string;
  count: number;
  /** RFC-6 line items sorted by blockNumber then paymentId, then coin payments by firstSeen. */
  payments: ReportPayment[];
}

export type ZReportPublishState = "pending" | "published" | "conflict";

/** A committed Z report — the fiscal close for a period, across both payment rails. */
export interface ZReportRecord extends ReportSnapshot {
  seq: number;
  committedAtMs: number;
  /** Which rails recorded payments in the period. */
  source: "v1" | "v2" | "mixed";
  /** On-chain publish lifecycle for this report's encrypted CID. */
  publishState: ZReportPublishState;
  /** Bulletin CID of the published encrypted report, set once `published`. */
  cid?: string;
  lastAttemptCid?: string;
}

export interface ReportState {
  /** First block of the open (not-yet-closed) fiscal period. */
  periodStartBlock: number;
  /** Sequence of the last committed Z report (0 = none). */
  lastZSeq: number;
}
