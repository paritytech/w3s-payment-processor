/**
 * Wallet-balance readout shown in Settings. The load-bearing rules: once the
 * host pushes a balance it renders as a token amount (planck → token at the
 * configured decimals), and an absent host wallet (`unavailable`) renders as a
 * status line, NOT a zero amount — "no wallet here" must never read as "empty
 * wallet".
 */
import { describe, expect, it } from "vitest";

import { coinBalanceReadout } from "@/features/v2/api/coin-balance-view.ts";

const DECIMALS = 6;

describe("coinBalanceReadout", () => {
  it("renders a pushed balance as a token amount at the configured decimals", () => {
    expect(coinBalanceReadout(12_340_000n, "ready", DECIMALS)).toEqual({ kind: "amount", token: 12.34 });
    expect(coinBalanceReadout(0n, "ready", DECIMALS)).toEqual({ kind: "amount", token: 0 });
  });

  it("shows the balance the moment it arrives, whatever the status still says", () => {
    expect(coinBalanceReadout(5_000_000n, "loading", DECIMALS)).toEqual({ kind: "amount", token: 5 });
  });

  it("shows a status line — never a zero amount — when there is no host wallet", () => {
    const view = coinBalanceReadout(null, "unavailable", DECIMALS);
    expect(view.kind).toBe("message");
  });

  it("surfaces a load failure with the red tone", () => {
    const view = coinBalanceReadout(null, "error", DECIMALS);
    expect(view).toMatchObject({ kind: "message", tone: "red" });
  });

  it("reads as a neutral status line while loading", () => {
    expect(coinBalanceReadout(null, "loading", DECIMALS)).toMatchObject({ kind: "message", tone: "neutral" });
    expect(coinBalanceReadout(null, "idle", DECIMALS)).toMatchObject({ kind: "message", tone: "neutral" });
  });

  it("falls back to a zero amount if the host reports ready before any balance push", () => {
    expect(coinBalanceReadout(null, "ready", DECIMALS)).toEqual({ kind: "amount", token: 0 });
  });
});
