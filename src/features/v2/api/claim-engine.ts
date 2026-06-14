// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import type { ClaimResult } from "@/features/v2/types.ts";

/**
 * Claims bearer coins into the host's own wallet. The SPA never signs — the
 * host credits itself via `paymentTopUp(Coins)`. Two implementations: an
 * enabled engine backed by the host payment manager, and a fail-closed disabled
 * engine (standalone, unbound, or a host SDK without the Coins variant).
 */
export interface ClaimEngine {
  /** Whether claims can actually settle (false ⇒ every claim is blocked). */
  readonly enabled: boolean;
  /** When disabled, the reason (surfaced as the record's claim diagnostic). */
  readonly diagnostic?: string;
  claim(coins: Uint8Array[], amountPlanck: bigint): Promise<ClaimResult>;
}

/**
 * The R6 diagnostic: the host payment SDK does not expose a Coins top-up
 * source, so bearer coins cannot be claimed. The decode pipeline still runs and
 * records `claim_blocked`; the claim is retried whenever the statement is
 * re-delivered, so a host upgrade unblocks queued payments without data loss.
 */
export const R6_NO_COINS_VARIANT =
  "R6: host payment SDK lacks the Coins top-up variant; claim blocked until the host ships it";

/**
 * Whether the host payment manager's `topUp` accepts a `{ type: 'coins' }`
 * source. True for `@novasamatech/host-api-wrapper` ≥ 0.8.x (the pinned
 * version), whose `TopUpSource` includes the coins variant. Flip to `false`
 * when building against an older SDK to exercise the R6 fail-closed path.
 */
export const HOST_SUPPORTS_COINS_TOPUP = true;

/** A claim engine that never settles — records a blocked claim with `reason`. */
export function createDisabledClaimEngine(reason: string): ClaimEngine {
  return {
    enabled: false,
    diagnostic: reason,
    claim: async () => ({ status: "claim_blocked", diagnostic: reason }),
  };
}

/** The narrow slice of the host payment manager the claim engine drives. */
export interface CoinsTopUpManager {
  topUp(amount: bigint, source: { type: "coins"; keys: Uint8Array[] }, into?: number): Promise<void>;
}

const DEFAULT_TOPUP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export interface CreateCoinsClaimEngineOptions {
  /** Override the default 30s top-up timeout (test seam; production uses the default). */
  timeoutMs?: number;
  /** topUp attempts per claim cycle before giving up (default 3). */
  maxAttempts?: number;
  /** Pause between attempts (default 2s — lets the host clear the failed tx). */
  retryDelayMs?: number;
}


export function createCoinsClaimEngine(
  manager: CoinsTopUpManager,
  options: CreateCoinsClaimEngineOptions = {},
): ClaimEngine {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOPUP_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const attemptTopUp = async (coins: Uint8Array[], amountPlanck: bigint): Promise<void> => {
    const { promise: timeout, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `host did not respond to paymentTopUp within ${timeoutMs}ms — ` +
              `likely a host-api codec mismatch (PaymentTopUpErr variant unknown to this SDK build); ` +
              `check the DebugPanel console for a preceding 'Transport error innerDecoder is not a function'`,
          ),
        ),
      timeoutMs,
    );
    try {
      await Promise.race([manager.topUp(amountPlanck, { type: "coins", keys: coins }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  // The claim queue. A single worker drains jobs FIFO, running exactly one
  // pallet call at a time (the host wallet can't safely process concurrent
  // top-ups). A job that fails — or times out, including a top-up that never
  // settles — is re-queued at the BACK rather than retried in place, so a slow
  // or hanging payment can never starve the claims behind it: they are
  // serviced between its attempts. After `maxAttempts` the job settles as
  // claim_failed. Because every attempt is bounded by `attemptTopUp`'s timeout,
  // a permanently-hanging top-up occupies the worker for at most one timeout
  // before yielding — it can never wedge the queue.
  interface ClaimJob {
    coins: Uint8Array[];
    amountPlanck: bigint;
    /** 1-based number of the attempt about to run; carried across re-queues. */
    attempt: number;
    settle: (result: ClaimResult) => void;
  }

  const queue: ClaimJob[] = [];
  let working = false;

  const enqueue = (job: ClaimJob): void => {
    queue.push(job);
    if (!working) void drain();
  };

  // Re-queue a failed job at the back. The retry delay is scheduled OFF the
  // worker (setTimeout) so it never blocks the jobs queued behind it; with a
  // zero delay the job is appended synchronously and picked up this drain.
  const requeue = (job: ClaimJob): void => {
    if (retryDelayMs > 0) setTimeout(() => enqueue(job), retryDelayMs);
    else enqueue(job);
  };

  const drain = async (): Promise<void> => {
    working = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        console.log(
          `[v2:claim] topUp attempt ${job.attempt}/${maxAttempts} (${job.amountPlanck}n, coins=${job.coins.length}) → ` +
            `host.coinpayment — host SDK builds the on-chain consume+credit tx from each 64B key (queue depth ${queue.length})`,
        );
        try {
          await attemptTopUp(job.coins, job.amountPlanck);
          console.log(
            `[v2:claim] topUp resolved — coins credited to host wallet` +
              (job.attempt > 1 ? ` (attempt ${job.attempt}/${maxAttempts})` : ""),
          );
          job.settle({ status: "claimed", attempts: job.attempt });
        } catch (error) {
          const diagnostic = error instanceof Error ? error.message : String(error);
          console.warn(`[v2:claim] topUp attempt ${job.attempt}/${maxAttempts} rejected/timed out: ${diagnostic}`);
          if (job.attempt >= maxAttempts) {
            job.settle({ status: "claim_failed", attempts: maxAttempts, diagnostic });
          } else {
            requeue({ ...job, attempt: job.attempt + 1 });
          }
        }
      }
    } finally {
      working = false;
    }
  };

  return {
    enabled: true,
    claim(coins: Uint8Array[], amountPlanck: bigint): Promise<ClaimResult> {
      const { promise, resolve } = Promise.withResolvers<ClaimResult>();
      enqueue({ coins, amountPlanck, attempt: 1, settle: resolve });
      return promise;
    },
  };
}

export interface ResolveClaimEngineOptions {
  inHost: boolean;
  /** Whether the bound product account matches a configured payout (binding ok). */
  bindingEnabled: boolean;
  /** Reason binding is disabled, if any. */
  bindingReason?: string;
  /** Build the host payment manager (only called when an enabled engine is selected). */
  createManager: () => CoinsTopUpManager;
  /** Override the coins-variant capability (defaults to the pinned SDK's support). */
  supportsCoinsTopUp?: boolean;
}

/**
 * Select the claim engine, failing closed in priority order: standalone →
 * unbound → SDK without Coins (R6) → enabled.
 */
export function resolveClaimEngine(options: ResolveClaimEngineOptions): ClaimEngine {
  if (!options.inHost) {
    return createDisabledClaimEngine("standalone: decode-only, no host wallet to claim into");
  }
  if (!options.bindingEnabled) {
    return createDisabledClaimEngine(options.bindingReason ?? "wallet binding failed");
  }
  if (options.supportsCoinsTopUp === false || (options.supportsCoinsTopUp === undefined && !HOST_SUPPORTS_COINS_TOPUP)) {
    return createDisabledClaimEngine(R6_NO_COINS_VARIANT);
  }
  return createCoinsClaimEngine(options.createManager());
}
