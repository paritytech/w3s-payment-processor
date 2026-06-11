// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * `duplicate` is not a claim outcome — it marks a statement that re-used an
 * already-settled payment id and was refused before reaching the claim engine
 * (no coins claimed). Claim engines never produce it.
 */
export type ClaimStatus = "claimed" | "claim_blocked" | "claim_failed" | "pending" | "duplicate";

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
  /**
   * Set on `duplicate` records: the settled payment id this statement re-used.
   * The record's own `id` is suffix-keyed so it never collides with the
   * original; `amount`/`coinsCount` describe the refused statement, NOT money
   * received — fiscal rollups must skip these.
   */
  duplicateOfId?: string;
  source: "v2";
}
