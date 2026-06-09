// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Transaction watcher. Vendored verbatim from
 * `apps/w3spay-admin/src/shared/chain/contracts/watch-transaction.ts`.
 */
import type { PolkadotSigner, TxEvent } from "polkadot-api";

import { stringifyResultValue } from "./read.ts";
import { withTimeout } from "./with-timeout.ts";

export type TxStatus =
  | "idle"
  | "preparing"
  | "signing"
  | "broadcasting"
  | "in-block"
  | "finalized"
  | "error";

export interface WatchableTx {
  readonly decodedCall?: unknown;
  signSubmitAndWatch(
    signer: PolkadotSigner,
    options?: unknown,
  ): {
    subscribe(observer: {
      next(event: TxEvent): void;
      error(error: unknown): void;
    }): { unsubscribe(): void };
  };
}
export type ChainEffectOracle = () => Promise<boolean>;

export interface WatchTransactionOptions {
  /**
   * Workaround for chains where `chainHead_v1_follow` doesn't deliver
   * `txBestBlocksState` through the host bridge.
   */
  waitForChainEffect?: ChainEffectOracle;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  signingTimeoutMs?: number;
}

interface TxBestBlocksEvent {
  type: "txBestBlocksState";
  found?: boolean;
  ok?: boolean;
  txHash?: string;
  dispatchError?: unknown;
}

interface TxFinalizedEvent {
  type: "finalized";
  ok?: boolean;
  txHash?: string;
  dispatchError?: unknown;
}

/** Refreshed on every chain event and completed poll — a responsive node keeps it from firing. */
const POST_BROADCAST_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_TIMEOUT_MS = 10_000;
const SIGNING_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function watchTransaction(
  tx: WatchableTx,
  signer: PolkadotSigner,
  onStatus?: (status: TxStatus) => void,
  options: WatchTransactionOptions = {},
): Promise<`0x${string}`> {
  onStatus?.("signing");
  const { promise, resolve, reject } = Promise.withResolvers<`0x${string}`>();

  let settled = false;
  let pollLoopStopped = false;
  let broadcastedHash: `0x${string}` | undefined;
  let subscription: { unsubscribe(): void } | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let signingTimer: ReturnType<typeof setTimeout> | undefined;
  const signingTimeoutMs = options.signingTimeoutMs ?? SIGNING_TIMEOUT_MS;

  const clearStall = () => {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };

  const clearSigning = () => {
    if (signingTimer !== undefined) {
      clearTimeout(signingTimer);
      signingTimer = undefined;
    }
  };

  const safeUnsubscribe = () => {
    try {
      subscription?.unsubscribe();
    } catch {
      // Best-effort — observable may already be closed.
    }
  };

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    pollLoopStopped = true;
    clearStall();
    clearSigning();
    onStatus?.("error");
    try {
      subscription?.unsubscribe();
    } finally {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const succeed = (txHash: `0x${string}`) => {
    if (settled) return;
    settled = true;
    pollLoopStopped = true;
    clearStall();
    clearSigning();
    onStatus?.("in-block");
    resolve(txHash);
  };

  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      fail(
        new Error(
          `transaction stalled: no inclusion within ${POST_BROADCAST_TIMEOUT_MS}ms of broadcast`,
        ),
      );
    }, POST_BROADCAST_TIMEOUT_MS);
  };

  const startPolling = () => {
    const probe = options.waitForChainEffect;
    if (!probe) return;
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

    void (async () => {
      // Yield one microtask so a same-tick event-path resolution can
      // flip `pollLoopStopped` and pre-empt polling entirely.
      await Promise.resolve();
      while (!pollLoopStopped && !settled) {
        try {
          const landed = await withTimeout(probe(), timeout, "waitForChainEffect");
          if (!settled) armStall();
          if (landed) {
            succeed(broadcastedHash ?? ("0x" as `0x${string}`));
            safeUnsubscribe();
            return;
          }
        } catch (caught) {
          console.warn("[watch-transaction] effect poll error (continuing)", caught);
        }
        if (pollLoopStopped || settled) return;
        await sleep(interval);
      }
    })();
  };

  signingTimer = setTimeout(() => {
    fail(
      new Error(
        `signing request timed out: no wallet response within ${signingTimeoutMs}ms ` +
          "(the host signing modal may not have appeared — reconnect the wallet and try again)",
      ),
    );
  }, signingTimeoutMs);

  subscription = tx
    .signSubmitAndWatch(signer, { mortality: { mortal: true, period: 256 } })
    .subscribe({
      next(event) {
        clearSigning();
        const evt = event as {
          type: string;
          found?: boolean;
          ok?: boolean;
          txHash?: string;
        };
        console.info("[watch-transaction] tx event", {
          type: evt.type,
          found: evt.found,
          ok: evt.ok,
          txHash: evt.txHash,
        });

        if (event.type === "signed") onStatus?.("signing");
        if (event.type === "broadcasted") {
          onStatus?.("broadcasting");
          armStall();
          broadcastedHash = evt.txHash as `0x${string}` | undefined;
          startPolling();
        }

        if (event.type === "txBestBlocksState") {
          armStall();
          const ev = event as TxBestBlocksEvent;
          if (ev.found) {
            if (ev.ok === false) {
              fail(new Error(`transaction failed in block: ${formatDispatchError(ev.dispatchError)}`));
              return;
            }
            succeed((ev.txHash ?? "0x") as `0x${string}`);
          }
        }

        if (event.type === "finalized") {
          const ev = event as TxFinalizedEvent;
          if (!settled) {
            if (ev.ok === false) {
              fail(new Error(`transaction finalized with dispatch error: ${formatDispatchError(ev.dispatchError)}`));
              return;
            }
            succeed((ev.txHash ?? "0x") as `0x${string}`);
          }
          onStatus?.("finalized");
          safeUnsubscribe();
        }
      },
      error(error) {
        fail(error);
      },
    });

  return promise;
}

function formatDispatchError(error: unknown): string {
  if (error == null) return "unknown dispatch error";
  if (typeof error === "string") return error;
  return stringifyResultValue(error);
}
