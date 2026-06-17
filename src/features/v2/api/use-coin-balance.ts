// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Live merchant coin balance from the host (`paymentBalanceSubscribe`). Updates
 * whenever coins are claimed, so it tracks the wallet as payments settle.
 * Host-only — a standalone tab has no bridge to the wallet and reports
 * `unavailable`.
 */
import { useEffect, useState } from "react";

import { createPaymentManager, sandboxTransport } from "@/shared/api/host/host-api.ts";
import { isInHost } from "@/shared/api/host/connection.ts";
import type { CoinBalanceStatus } from "@/features/v2/api/coin-balance-view.ts";

export interface UseCoinBalance {
  /** Available balance in planck (smallest unit); null until the first push. */
  availablePlanck: bigint | null;
  status: CoinBalanceStatus;
  error: string | null;
}

export function useCoinBalance(): UseCoinBalance {
  const [availablePlanck, setAvailablePlanck] = useState<bigint | null>(null);
  const [status, setStatus] = useState<CoinBalanceStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isInHost()) {
      setStatus("unavailable");
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const subscribeOnce = (): (() => void) => {
      const manager = createPaymentManager(sandboxTransport);
      const sub = manager.subscribeBalance((balance) => {
        if (cancelled) return;
        setAvailablePlanck(balance.available);
        setStatus("ready");
      });
      // The host can drop the subscription on reconnect; re-establish it or the
      // balance would silently freeze at the last value.
      sub.onInterrupt(() => {
        if (cancelled) return;
        unsubscribe = subscribeOnce();
      });
      return () => sub.unsubscribe();
    };

    try {
      setStatus("loading");
      unsubscribe = subscribeOnce();
    } catch (err) {
      if (!cancelled) {
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return { availablePlanck, status, error };
}
