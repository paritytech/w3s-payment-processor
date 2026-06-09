// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

export type ClaimStatus = "claimed" | "claim_blocked" | "claim_failed" | "pending";

export interface ClaimResult {
  status: ClaimStatus;
  diagnostic?: string;
  /** How many topUp attempts this claim cycle made (absent for blocked claims). */
  attempts?: number;
}

/**
 * A decoded + (attempted-)claimed Coinage statement payment. `id` is the
 * payload id — the dedupe key, idempotent across restarts.
 */
export interface PaymentRecord {
  id: string;
  terminalId: string;
  /** Lowercase hex of the topic this arrived on. */
  topicHex: string;
  amount: string;
  amountPlanck: string;
  coinsCount: number;
  timestampMs: number;
  firstSeenAtMs: number;
  claimStatus: ClaimStatus;
  claimDiagnostic?: string;
  /** Cumulative topUp attempts across all deliveries of this payment. */
  claimAttempts?: number;
  claimedAtMs?: number;
  source: "v2";
}
