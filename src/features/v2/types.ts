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
 * payload id chosen by the sender — only unique within one sender's numbering,
 * so it is NOT the dedupe key on its own; see `v2PaymentKey`.
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

/**
 * Dedupe + storage identity of a v2 payment. The payload `id` is payer-chosen
 * and only unique within one sender's numbering, so it is scoped by the
 * terminal topic and the payload timestamp. Two genuinely-distinct sales that
 * share an `id` — a second till re-using a ticket number, or one till
 * re-presenting after an already-settled sale — differ in `(topicHex,
 * timestampMs)` and stay separate; gossip re-deliveries of one statement
 * (identical on all three) collapse onto the same key.
 */
export function v2PaymentKey(topicHex: string, id: string, timestampMs: number): string {
  return `${topicHex}:${id}:${timestampMs}`;
}
