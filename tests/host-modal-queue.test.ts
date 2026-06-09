/**
 * Host-modal promise queue (`runExclusiveHostModal`) + the boot permission
 * grants that ride it. The host shows ONE modal at a time and silently drops
 * any request that arrives while another is open — the queue is what makes
 * concurrent grants from independent modules (boot fan-out in instrument.ts
 * vs the v1 engine's `requestChainRemotePermissions`) safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestPermissionMock = vi.fn();

vi.mock("@/shared/api/host/host-api.ts", () => ({
  requestPermission: (...args: unknown[]) => requestPermissionMock(...args),
  sandboxProvider: { isCorrectEnvironment: () => true },
  sandboxTransport: { isReady: () => Promise.resolve(true) },
}));

/** Fresh module registry per test — connection.ts holds queue/cache state. */
async function freshConnection() {
  vi.resetModules();
  return import("@/shared/api/host/connection.ts");
}

/**
 * Yield enough microtask turns for the connect→queue→task promise chains to
 * progress — no timers. 25 comfortably exceeds the deepest chain (~8 turns).
 */
async function flush(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

/** A controllable host grant in the wrapper's `.match(ok, err)` shape. */
function deferredGrant() {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  return {
    result: { match: <T,>(ok: (granted: boolean) => T) => promise.then(ok) },
    resolve,
  };
}

function grantImmediately() {
  return { match: <T,>(ok: (granted: boolean) => T) => Promise.resolve(ok(true)) };
}

function denyImmediately() {
  return { match: <T,>(ok: (granted: boolean) => T) => Promise.resolve(ok(false)) };
}

beforeEach(() => {
  requestPermissionMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runExclusiveHostModal", () => {
  it("runs tasks strictly FIFO — task N+1 starts only after task N settles", async () => {
    const { runExclusiveHostModal } = await freshConnection();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();

    const first = runExclusiveHostModal(async () => {
      order.push("a-start");
      await gate.promise;
      order.push("a-end");
    });
    const second = runExclusiveHostModal(async () => {
      order.push("b");
    });

    await flush();
    expect(order).toEqual(["a-start"]); // b waits while a's modal is open

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("a rejecting task surfaces to its caller but never wedges the queue", async () => {
    const { runExclusiveHostModal } = await freshConnection();
    const first = runExclusiveHostModal(async () => {
      throw new Error("denied");
    });
    const second = runExclusiveHostModal(async () => "ran");

    await expect(first).rejects.toThrow("denied");
    await expect(second).resolves.toBe("ran");
  });

  it("the hard ceiling releases the queue when a modal never settles", async () => {
    vi.useFakeTimers();
    const { runExclusiveHostModal } = await freshConnection();
    const order: string[] = [];
    const never = Promise.withResolvers<void>();

    void runExclusiveHostModal(() => never.promise); // host never answers
    const second = runExclusiveHostModal(async () => {
      order.push("b");
      return "ran";
    });

    await flush();
    expect(order).toEqual([]); // still locked

    await vi.advanceTimersByTimeAsync(120_000); // HOST_MODAL_MAX_LOCK_MS
    await expect(second).resolves.toBe("ran");
  });
});

describe("requestRemotePermission", () => {
  it("resolves granted outside a host without touching the host API", async () => {
    const { requestRemotePermission } = await freshConnection();
    await expect(requestRemotePermission("ChainSubmit")).resolves.toEqual({ granted: true });
    expect(requestPermissionMock).not.toHaveBeenCalled();
  });

  it("prompts once and caches the grant for repeat calls", async () => {
    vi.stubGlobal("window", { __HOST_WEBVIEW_MARK__: true });
    requestPermissionMock.mockReturnValue(grantImmediately());
    const conn = await freshConnection();

    await expect(conn.requestRemotePermission("ChainSubmit")).resolves.toEqual({ granted: true });
    await expect(conn.requestRemotePermission("ChainSubmit")).resolves.toEqual({ granted: true });

    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(requestPermissionMock).toHaveBeenCalledWith({ tag: "ChainSubmit", value: undefined });
  });

  it("does not cache a denial — the next call re-prompts", async () => {
    vi.stubGlobal("window", { __HOST_WEBVIEW_MARK__: true });
    requestPermissionMock.mockReturnValue(denyImmediately());
    const conn = await freshConnection();

    await expect(conn.requestRemotePermission("PreimageSubmit")).resolves.toEqual({ granted: false });
    await expect(conn.requestRemotePermission("PreimageSubmit")).resolves.toEqual({ granted: false });
    expect(requestPermissionMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent same-kind calls share one in-flight modal", async () => {
    vi.stubGlobal("window", { __HOST_WEBVIEW_MARK__: true });
    const grant = deferredGrant();
    requestPermissionMock.mockReturnValue(grant.result);
    const conn = await freshConnection();

    const a = conn.requestRemotePermission("ChainSubmit");
    const b = conn.requestRemotePermission("ChainSubmit");
    await flush();
    expect(requestPermissionMock).toHaveBeenCalledTimes(1);

    grant.resolve(true);
    await expect(a).resolves.toEqual({ granted: true });
    await expect(b).resolves.toEqual({ granted: true });
  });

  it("waits for an open modal instead of being dropped (boot-race regression)", async () => {
    vi.stubGlobal("window", { __HOST_WEBVIEW_MARK__: true });
    const sentryGrant = deferredGrant();
    const chainGrant = deferredGrant();
    requestPermissionMock
      .mockReturnValueOnce(sentryGrant.result)
      .mockReturnValueOnce(chainGrant.result);
    const conn = await freshConnection();

    // Boot fan-out opens the Sentry remote-origin modal…
    const sentry = conn.requestRemoteOriginPermission(["sentry.example.com"]);
    await flush();
    expect(requestPermissionMock).toHaveBeenCalledTimes(1);

    // …and the v1 engine concurrently requests its grant. Pre-queue, the host
    // would silently drop this prompt; now it waits in line.
    const chain = conn.requestRemotePermission("ChainSubmit");
    await flush();
    expect(requestPermissionMock).toHaveBeenCalledTimes(1); // still queued

    sentryGrant.resolve(true);
    await expect(sentry).resolves.toEqual({ granted: true });
    await flush();
    expect(requestPermissionMock).toHaveBeenCalledTimes(2); // fired after modal 1 closed

    chainGrant.resolve(true);
    await expect(chain).resolves.toEqual({ granted: true });
  });
});
