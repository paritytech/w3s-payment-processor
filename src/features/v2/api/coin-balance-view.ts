// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { toToken } from "@/shared/utils/ui-format.ts";
import type { Tone } from "@/shared/utils/tone.ts";

export type CoinBalanceStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

export type CoinBalanceView =
  | { kind: "amount"; token: number }
  | { kind: "message"; text: string; tone: Tone };

/**
 * Map the live coin-balance subscription state to what the wallet card shows:
 * a token amount once the host has pushed a balance, otherwise a status line.
 * `unavailable` (standalone, no host wallet) reads as an em dash, never `0`, so
 * "no wallet here" is never mistaken for "an empty wallet".
 */
export function coinBalanceReadout(
  availablePlanck: bigint | null,
  status: CoinBalanceStatus,
  decimals: number,
): CoinBalanceView {
  if (availablePlanck != null) return { kind: "amount", token: toToken(availablePlanck, decimals) };
  switch (status) {
    case "unavailable":
      return { kind: "message", text: "—", tone: "neutral" };
    case "error":
      return { kind: "message", text: "Couldn't load the balance — check the host connection.", tone: "red" };
    case "ready":
      return { kind: "amount", token: 0 };
    default:
      return { kind: "message", text: "Loading…", tone: "neutral" };
  }
}
