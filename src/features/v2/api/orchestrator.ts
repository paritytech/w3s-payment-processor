// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v2 ingest pipeline: topic-match → ECIES decrypt → dedupe by payload id →
 * claim (per-terminal binding gate) → persist. Decrypt/decode failures on open
 * topics are counted and ignored (spam-resistant). Idempotent across restarts:
 * a fully-claimed record never re-claims; a blocked/failed one retries on
 * re-delivery.
 *
 * Pure-ish core — all I/O (host statement source, claim engine, persistence) is
 * injected, so the whole pipeline is unit-tested with the real ECIES decrypt.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { decryptStatementData } from "@/shared/utils/wire/ecies";
import { topicKey } from "@/shared/utils/wire/topic";
import { parseAmountToPlanck } from "@/shared/utils/format.ts";
import type { ResolvedV2Terminal } from "@/config.ts"
import type { BindingResult } from "@/features/v2/api/binding.ts";
import type { ClaimEngine } from "@/features/v2/api/claim-engine.ts";
import type { ClaimResult, PaymentRecord } from "@/features/v2/types.ts";

/** Minimal statement shape consumed from the host statement-store page. */
export interface StatementLike {
  topics: Uint8Array[];
  data?: Uint8Array;
  /**
   * Optional auxiliary key material the publisher attached to the statement
   * (statement-store first-class field, separate from `data`). Surfaced in
   * decode-failure diagnostics — not currently consumed by the decrypt path.
   */
  decryptionKey?: Uint8Array;
}

export interface OrchestratorDeps {
  /** topicHex → terminal (built from the resolved v2 terminals). */
  terminalsByTopic: ReadonlyMap<string, ResolvedV2Terminal>;
  claimEngine: ClaimEngine;
  binding: BindingResult;
  tokenDecimals: number;
  /** In-memory record set, seeded from durable records on boot; mutated in place. */
  records: Map<string, PaymentRecord>;
  /**
   * Payment IDs whose claim is currently awaiting `claimEngine.claim`. The
   * orchestrator atomically adds the id before the await and removes it in
   * `finally`, so a re-delivered statement (statement-store gossip re-emits
   * each statement every few seconds) is dropped instead of triggering a
   * parallel claim. Without this, a slow top-up — or one that times out at
   * 30s — would fan out into dozens of concurrent `paymentTopUp` requests per
   * cheque before the first record is written.
   */
  inflight: Set<string>;
  /**
   * Wall-clock (unix ms) of "now, modulo a small grace window" at engine
   * startup. Statements whose decrypted payload `timestamp` predates this are
   * treated as backlog — they were either created in a previous session (the
   * chain coins are almost certainly already spent) or are stale gossip
   * re-deliveries from the node's retention window. Skipping them avoids a
   * cascade of `paymentTopUp` calls against already-spent coins on engine
   * startup, which the host currently rejects with a `PaymentTopUpErr` variant
   * this SDK build can't decode (dropped at the transport, force-times out
   * after 30s per cheque).
   */
  sessionStartMs: number;
  persist: (record: PaymentRecord) => Promise<void>;
  /** Counter + diagnostic for ignored decrypt/decode failures on watched topics (spam metric). `reason` describes the stage and underlying error. */
  onDecodeFailure?: (topicHex: string, reason: string) => void;
  now?: () => number;
}


function findTerminal(
  statement: StatementLike,
  terminalsByTopic: ReadonlyMap<string, ResolvedV2Terminal>,
): { terminal: ResolvedV2Terminal; topicHex: string } | null {
  for (const topic of statement.topics) {
    const hex = topicKey(topic);
    const terminal = terminalsByTopic.get(hex);
    if (terminal) return { terminal, topicHex: hex };
  }
  return null;
}

/** Ingest one statement. Returns the resulting record, or null when it is not for us. */
export async function ingestStatement(
  statement: StatementLike,
  deps: OrchestratorDeps,
): Promise<PaymentRecord | null> {
  const match = findTerminal(statement, deps.terminalsByTopic);
  if (!match || !statement.data) return null;

  let amount: string;
  let coins: Uint8Array[];
  let id: string;
  let timestamp: bigint;
  try {
    const { payload } = decryptStatementData(match.terminal.privKey, statement.data);
    ({ amount, coins, id, timestamp } = payload);
    // Observable success log: the unwrap+decrypt+SCALE-decode pipeline produced
    // a well-formed payment payload. Logged before the amount-parse and claim
    // stages so a missing follow-up log here means it's the claim/topUp path
    // that's hanging, not the decode.
    console.log(
      `[v2:decode] ok terminal=${match.terminal.terminalId} ` +
        `id=${JSON.stringify(id)} amount=${amount} coins=${coins.length} ` +
        `timestamp=${timestamp} (envelope ${statement.data.length}B)`,
    );
  } catch (error) {
    // Decrypt or SCALE-decode failure on an open topic — spam; count and ignore.
    const fullHex = bytesToHex(statement.data);
    const tail = bytesToHex(statement.data.subarray(Math.max(0, statement.data.length - 16)));
    const dk = statement.decryptionKey;
    const dkInfo = dk && dk.length > 0
      ? `decryptionKey=${dk.length}B/${bytesToHex(dk.subarray(0, Math.min(16, dk.length)))}`
      : "decryptionKey=<none>";
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    deps.onDecodeFailure?.(
      match.topicHex,
      `decrypt failed (${cause}; ${statement.data.length}B envelope; tail=${tail}; ${dkInfo}; full=${fullHex})`,
    );
    return null;
  }

  const existing = deps.records.get(id);
  if (existing && existing.claimStatus === "claimed") return existing; // idempotent on settled claim

  // Stale-backlog skip: a fresh subscription delivers everything in the local
  // node's gossip-retention window (minutes-to-hours of statements), and the
  // chain coins backing pre-session cheques are almost always already spent.
  // Calling `topUp` against them produces a cascade of host-rejection
  // responses — currently each hangs for 30s because the rejection variant
  // isn't in the SDK's codec — so we cut them off before the claim path.
  const tsMs = Number(timestamp);
  if (tsMs < deps.sessionStartMs) {
    console.log(
      `[v2:skip] stale backlog id=${JSON.stringify(id)} timestamp=${tsMs} ` +
        `< sessionStart=${deps.sessionStartMs}; not claiming ` +
        `(predates this session — chain coin almost certainly already spent)`,
    );
    return null;
  }

  // In-flight dedupe: the host's statement-store gossip re-delivers each
  // statement every few seconds. Without this guard, every re-delivery (until
  // the first claim settles) would fire a fresh `paymentTopUp` — with a 30s
  // claim timeout that means ~10–30 concurrent host requests per cheque.
  if (deps.inflight.has(id)) {
    console.log(
      `[v2:dedupe] in-flight claim for id=${JSON.stringify(id)}; ` +
        `skipping page re-delivery (statement-store gossip re-emit)`,
    );
    return null;
  }

  let amountPlanck: bigint;
  try {
    amountPlanck = parseAmountToPlanck(amount, deps.tokenDecimals);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    deps.onDecodeFailure?.(match.topicHex, `amount parse failed (${cause}; amount=${JSON.stringify(amount)})`);
    return null;
  }

  deps.inflight.add(id);
  let result: ClaimResult;
  try {
    result = await deps.claimEngine.claim(coins, amountPlanck);
  } finally {
    deps.inflight.delete(id);
  }

  const now = deps.now?.() ?? Date.now();
  // Cumulative across deliveries: gossip re-delivers a failed cheque, and each
  // cycle adds its attempts — the record always says how often we tried.
  const claimAttempts = (existing?.claimAttempts ?? 0) + (result.attempts ?? 0);
  const record: PaymentRecord = {
    id,
    terminalId: match.terminal.terminalId,
    topicHex: match.topicHex,
    amount,
    amountPlanck: amountPlanck.toString(),
    coinsCount: coins.length,
    timestampMs: Number(timestamp),
    firstSeenAtMs: existing?.firstSeenAtMs ?? now,
    claimStatus: result.status,
    claimDiagnostic:
      result.status === "claim_failed"
        ? `failed after ${claimAttempts} attempt${claimAttempts === 1 ? "" : "s"} — ` +
          (result.diagnostic ?? "host rejected the top-up")
        : result.diagnostic,
    claimAttempts,
    claimedAtMs: result.status === "claimed" ? now : existing?.claimedAtMs,
    source: "v2",
  };
  deps.records.set(id, record);
  await deps.persist(record);
  return record;
}

/** Ingest a page of statements in order, returning the records that were ours. */
export async function ingestPage(
  statements: readonly StatementLike[],
  deps: OrchestratorDeps,
): Promise<PaymentRecord[]> {
  const out: PaymentRecord[] = [];
  for (const statement of statements) {
    const record = await ingestStatement(statement, deps);
    if (record) out.push(record);
  }
  return out;
}

/** Build the topicHex → terminal index the orchestrator routes on. */
export function indexTerminalsByTopic(
  terminals: readonly ResolvedV2Terminal[],
): Map<string, ResolvedV2Terminal> {
  const map = new Map<string, ResolvedV2Terminal>();
  for (const terminal of terminals) map.set(terminal.topicHex, terminal);
  return map;
}
