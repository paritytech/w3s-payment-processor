import { describe, expect, it, vi } from "vitest";

import {
  R6_NO_COINS_VARIANT,
  createCoinsClaimEngine,
  createDisabledClaimEngine,
  resolveClaimEngine,
  type CoinsTopUpManager,
} from "@/features/v2/api/claim-engine.ts";

const coins = [new Uint8Array(64).fill(1), new Uint8Array(64).fill(2)];

describe("createCoinsClaimEngine", () => {
  it("claims when topUp resolves, forwarding the parsed planck amount + coins", async () => {
    const topUp = vi.fn(async () => undefined);
    const engine = createCoinsClaimEngine({ topUp } satisfies CoinsTopUpManager);
    const result = await engine.claim(coins, 12_340_000n);
    expect(result).toEqual({ status: "claimed", attempts: 1 });
    expect(topUp).toHaveBeenCalledWith(12_340_000n, { type: "coins", keys: coins });
    expect(topUp).toHaveBeenCalledTimes(1); // no pointless retries on success
  });

  it("retries a failing topUp and claims when a later attempt succeeds", async () => {
    const topUp = vi
      .fn<CoinsTopUpManager["topUp"]>()
      .mockRejectedValueOnce(new Error("host busy"))
      .mockRejectedValueOnce(new Error("host busy"))
      .mockResolvedValueOnce(undefined);
    const engine = createCoinsClaimEngine({ topUp }, { retryDelayMs: 0 });
    const result = await engine.claim(coins, 1n);
    expect(result).toEqual({ status: "claimed", attempts: 3 });
    expect(topUp).toHaveBeenCalledTimes(3);
  });

  it("fails closed after 3 attempts, carrying the attempt count and last cause", async () => {
    const topUp = vi.fn(async () => {
      throw new Error("host busy");
    });
    const engine = createCoinsClaimEngine({ topUp }, { retryDelayMs: 0 });
    const result = await engine.claim(coins, 1n);
    expect(result).toEqual({ status: "claim_failed", attempts: 3, diagnostic: "host busy" });
    expect(topUp).toHaveBeenCalledTimes(3); // tried, tried, tried — then gave up
  });

  it("serializes claims — a pallet call never runs while another is in flight", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const topUp = vi.fn((): Promise<void> => gates[topUp.mock.calls.length - 1]!.promise);
    const engine = createCoinsClaimEngine({ topUp });

    const first = engine.claim([coins[0]!], 1n);
    const second = engine.claim([coins[1]!], 2n);
    await flushMicrotasks();
    expect(topUp).toHaveBeenCalledTimes(1); // second waits in the queue

    gates[0]!.resolve();
    await expect(first).resolves.toEqual({ status: "claimed", attempts: 1 });
    await flushMicrotasks();
    expect(topUp).toHaveBeenCalledTimes(2); // fired only after the first settled

    gates[1]!.resolve();
    await expect(second).resolves.toEqual({ status: "claimed", attempts: 1 });
  });

  it("times out into claim_failed when topUp never settles (host response decode dropped at the transport)", async () => {
    // Reproduces the production hang: when the host returns a `PaymentTopUpErr`
    // variant the SDK doesn't recognize, `Message.dec` throws inside
    // `transport.js` and the response is dropped, leaving the wrapper's topUp
    // Promise pending forever. The timeout converts that into a clean
    // claim_failed so the orchestrator never stalls a page.
    const hangingManager: CoinsTopUpManager = {
      topUp: () => new Promise<void>(() => { /* never resolves */ }),
    };
    const engine = createCoinsClaimEngine(hangingManager, { timeoutMs: 25, maxAttempts: 1 });
    const result = await engine.claim(coins, 1n);
    expect(result.status).toBe("claim_failed");
    expect(result.diagnostic).toMatch(/host did not respond to paymentTopUp within 25ms/);
    expect(result.diagnostic).toMatch(/PaymentTopUpErr variant unknown/);
  });
});

/** Yield a few microtask turns so queued `.then` chains progress — no timers. */
async function flushMicrotasks(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

describe("createDisabledClaimEngine", () => {
  it("always blocks with the given reason", async () => {
    const engine = createDisabledClaimEngine("nope");
    expect(engine.enabled).toBe(false);
    expect(await engine.claim(coins, 1n)).toEqual({ status: "claim_blocked", diagnostic: "nope" });
  });
});

describe("resolveClaimEngine — fail-closed priority", () => {
  const createManager = vi.fn((): CoinsTopUpManager => ({ topUp: async () => undefined }));

  it("standalone ⇒ disabled, never builds a manager", async () => {
    const engine = resolveClaimEngine({ inHost: false, bindingEnabled: true, createManager });
    expect(engine.enabled).toBe(false);
    expect(createManager).not.toHaveBeenCalled();
  });

  it("unbound ⇒ disabled with the binding reason", () => {
    const engine = resolveClaimEngine({ inHost: true, bindingEnabled: false, bindingReason: "mismatch", createManager });
    expect(engine.enabled).toBe(false);
    expect(engine.diagnostic).toBe("mismatch");
  });

  it("host without the Coins variant ⇒ disabled with the R6 diagnostic", () => {
    const engine = resolveClaimEngine({ inHost: true, bindingEnabled: true, supportsCoinsTopUp: false, createManager });
    expect(engine.enabled).toBe(false);
    expect(engine.diagnostic).toBe(R6_NO_COINS_VARIANT);
  });

  it("in-host + bound + coins-capable ⇒ enabled coins engine", () => {
    const engine = resolveClaimEngine({ inHost: true, bindingEnabled: true, supportsCoinsTopUp: true, createManager });
    expect(engine.enabled).toBe(true);
  });
});
