/**
 * Merchant-selectable chain transport. Covers the persisted host/rpc choice,
 * the per-transport PAPI client cache (switching must rebuild clients, not
 * reuse host-bridge ones), stale-client reaping, and the remote-origin
 * permission gate: the host's "allow web domain" prompt must fire only on the
 * direct-RPC transport, never on plain host-network boots.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeProvider {
  kind: "ws" | "papi";
  url?: string;
  genesis?: string;
  fallback?: FakeProvider;
}

interface FakeClient {
  provider: FakeProvider;
  destroyed: boolean;
  destroy(): void;
}

const isInHostMock = vi.fn(() => true);
const requestRemoteOriginPermissionMock = vi.fn(async (_origins: readonly string[]) => ({ granted: true }));

vi.mock("polkadot-api", () => ({
  createClient: (provider: FakeProvider): FakeClient => {
    const client: FakeClient = {
      provider,
      destroyed: false,
      destroy() {
        client.destroyed = true;
      },
    };
    return client;
  },
}));
vi.mock("@polkadot-api/ws-provider", () => ({
  getWsProvider: (url: string): FakeProvider => ({ kind: "ws", url }),
}));
vi.mock("@/shared/api/host/host-api.ts", () => ({
  createPapiProvider: (genesis: string, fallback: FakeProvider): FakeProvider => ({
    kind: "papi",
    genesis,
    fallback,
  }),
}));
vi.mock("@/shared/api/host/connection.ts", () => ({
  isInHost: () => isInHostMock(),
  requestRemoteOriginPermission: (origins: readonly string[]) =>
    requestRemoteOriginPermissionMock(origins),
}));

import {
  DEFAULT_CHAIN_TRANSPORT,
  getChainTransport,
  resetChainTransportCache,
  setChainTransport,
} from "@/shared/api/chain-transport.ts";
import {
  dropStaleTransportClients,
  mainChainClient,
  requestChainRemotePermissions,
  resetClientCache,
} from "@/shared/api/client.ts";
import { envConfig } from "@/config.ts";

function fakeLocalStorage(seed: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

beforeEach(() => {
  resetChainTransportCache();
  resetClientCache();
  isInHostMock.mockReturnValue(true);
  requestRemoteOriginPermissionMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chain-transport store", () => {
  it("defaults to host when no storage exists", () => {
    expect(getChainTransport()).toBe("host");
    expect(DEFAULT_CHAIN_TRANSPORT).toBe("host");
  });

  it("persists the choice and re-hydrates from storage", () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
    setChainTransport("rpc");
    expect(storage.getItem("w3spay-chain-transport:v1")).toBe("rpc");

    resetChainTransportCache();
    expect(getChainTransport()).toBe("rpc");
  });

  it("falls back to the default on garbage stored values", () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({ "w3spay-chain-transport:v1": "carrier-pigeon" }),
    );
    expect(getChainTransport()).toBe("host");
  });
});

describe("client transport routing", () => {
  it("routes through the host bridge on host, straight WS on rpc, cached per transport", () => {
    setChainTransport("host");
    const hostClient = mainChainClient() as unknown as FakeClient;
    expect(hostClient.provider.kind).toBe("papi");
    expect(hostClient.provider.genesis).toBe(envConfig.network.mainChain.genesisHash);
    expect(hostClient.provider.fallback?.kind).toBe("ws");
    expect(mainChainClient() as unknown as FakeClient).toBe(hostClient);

    setChainTransport("rpc");
    const rpcClient = mainChainClient() as unknown as FakeClient;
    expect(rpcClient).not.toBe(hostClient);
    expect(rpcClient.provider).toEqual({ kind: "ws", url: envConfig.network.mainChain.wsUrl });
    expect(mainChainClient() as unknown as FakeClient).toBe(rpcClient);
  });

  it("dropStaleTransportClients reaps only the inactive transport's clients", () => {
    setChainTransport("host");
    const hostClient = mainChainClient() as unknown as FakeClient;
    setChainTransport("rpc");
    const rpcClient = mainChainClient() as unknown as FakeClient;

    dropStaleTransportClients();
    expect(hostClient.destroyed).toBe(true);
    expect(rpcClient.destroyed).toBe(false);
    expect(mainChainClient() as unknown as FakeClient).toBe(rpcClient);
  });
});

describe("requestChainRemotePermissions", () => {
  it("never prompts on the host transport", async () => {
    setChainTransport("host");
    await requestChainRemotePermissions();
    expect(requestRemoteOriginPermissionMock).not.toHaveBeenCalled();
  });

  it("prompts with the chain RPC hostnames on the rpc transport", async () => {
    setChainTransport("rpc");
    await requestChainRemotePermissions();
    expect(requestRemoteOriginPermissionMock).toHaveBeenCalledExactlyOnceWith([
      "paseo-asset-hub-next-rpc.polkadot.io",
      "paseo-people-next-system-rpc.polkadot.io",
    ]);
  });

  it("is a no-op outside a host even on the rpc transport", async () => {
    setChainTransport("rpc");
    isInHostMock.mockReturnValue(false);
    await requestChainRemotePermissions();
    expect(requestRemoteOriginPermissionMock).not.toHaveBeenCalled();
  });
});
