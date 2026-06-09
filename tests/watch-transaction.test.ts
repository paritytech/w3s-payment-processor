
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolkadotSigner } from "polkadot-api";

import {
  watchTransaction,
  type WatchableTx,
} from "@/shared/api/contracts/watch-transaction.ts";

const SIGNER = { publicKey: new Uint8Array(32) } as unknown as PolkadotSigner;

interface FakeObserver {
  next(event: unknown): void;
  error(error: unknown): void;
}

/** A controllable tx whose event stream the test drives by hand. */
function fakeTx() {
  let observer: FakeObserver | undefined;
  const unsubscribe = vi.fn();
  const tx: WatchableTx = {
    signSubmitAndWatch: () =>
      ({
        subscribe(obs: FakeObserver) {
          observer = obs;
          return { unsubscribe };
        },
      }) as never,
  } as WatchableTx;
  return {
    tx,
    emit: (event: unknown) => observer!.next(event),
    errorOut: (error: unknown) => observer!.error(error),
    unsubscribe,
  };
}

function rpcInternalError(): Error {
  return Object.assign(new Error("Internal error"), { name: "RpcError" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watchTransaction — stream-error resilience", () => {
  it("falls back to the chain-effect poll when the stream errors after broadcast", async () => {
    vi.useFakeTimers();
    const { tx, emit, errorOut } = fakeTx();
    let polls = 0;
    const oracle = vi.fn(async () => {
      polls += 1;
      return polls >= 2; // not landed on the first probe, landed on the second
    });

    const done = watchTransaction(tx, SIGNER, undefined, {
      waitForChainEffect: oracle,
      pollIntervalMs: 1_000,
    });
    emit({ type: "broadcasted", txHash: "0xabc" });
    errorOut(rpcInternalError());

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toBe("0xabc");
    expect(oracle).toHaveBeenCalled();
  });

  it("still fails when the stream errors after broadcast WITHOUT an oracle", async () => {
    const { tx, emit, errorOut } = fakeTx();
    const done = watchTransaction(tx, SIGNER);
    emit({ type: "broadcasted", txHash: "0xabc" });
    errorOut(rpcInternalError());
    await expect(done).rejects.toThrow("Internal error");
  });

  it("fails fast on a pre-broadcast error (signer rejection) even with an oracle", async () => {
    const { tx, errorOut } = fakeTx();
    const done = watchTransaction(tx, SIGNER, undefined, {
      waitForChainEffect: async () => true,
    });
    errorOut(new Error("Cancelled by user"));
    await expect(done).rejects.toThrow("Cancelled by user");
  });
});
