/**
 * The sandboxed Polkadot host denies network access to non-allowlisted
 * origins by throwing synchronously from the WebSocket constructor
 * ("TypeError: Network access is not allowed"). polkadot-api's ws-provider
 * constructs sockets with no try/catch, so the throw would escape as an
 * uncaught crash and bypass the provider's halt/retry path. The shim must
 * convert that denial into an async error+close on a dead socket, and stay a
 * transparent pass-through when the constructor succeeds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const isInHostMock = vi.fn(() => true);

vi.mock("@/shared/api/host/connection.ts", () => ({
  isInHost: () => isInHostMock(),
}));

import {
  SandboxSafeWebSocket,
  sandboxSafeWsConfig,
} from "@/shared/api/sandbox-safe-websocket.ts";

class FakeWebSocket {
  url: string;
  constructor(url: string | URL) {
    this.url = String(url);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SandboxSafeWebSocket", () => {
  it("passes through the native socket when construction succeeds", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const socket = new SandboxSafeWebSocket("wss://rpc.example");
    expect(socket).toBeInstanceOf(FakeWebSocket);
    expect(socket.url).toBe("wss://rpc.example");
  });

  it("converts a synchronous constructor denial into async error+close", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new TypeError("Network access is not allowed");
        }
      },
    );

    const socket = new SandboxSafeWebSocket("wss://blocked.example");
    expect(socket.url).toBe("wss://blocked.example");
    expect(socket.readyState).toBe(3);
    expect(() => socket.send("ping")).not.toThrow();
    expect(() => socket.close()).not.toThrow();

    const events: string[] = [];
    socket.addEventListener("error", () => events.push("error"));
    socket.addEventListener("close", () => events.push("close"));
    expect(events).toEqual([]);

    vi.runAllTimers();
    expect(events).toEqual(["error", "close"]);
  });

  it("honors once-listeners on the denied socket (provider cleanup path)", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new TypeError("Network access is not allowed");
        }
      },
    );

    const socket = new SandboxSafeWebSocket("wss://blocked.example");
    const onError = vi.fn();
    socket.addEventListener("error", onError, { once: true });
    socket.removeEventListener("error", onError);

    vi.runAllTimers();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("sandboxSafeWsConfig", () => {
  it("swaps in the shim only in-host", () => {
    isInHostMock.mockReturnValue(true);
    expect(sandboxSafeWsConfig()).toEqual({ websocketClass: SandboxSafeWebSocket });

    isInHostMock.mockReturnValue(false);
    expect(sandboxSafeWsConfig()).toBeUndefined();
  });
});
