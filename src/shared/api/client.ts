// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * PAPI client cache. One client per genesis hash + transport.
 *
 * The merchant-selectable chain transport (`shared/api/chain-transport.ts`)
 * decides how JSON-RPC reaches the chain:
 *
 * - `"host"` (default) — in-host, route PAPI JSON-RPC through the Polkadot
 *   host bridge with NO direct-WebSocket fallback: on this transport the RPC
 *   origins are never allowlisted, so the SDK fallback (which engages on any
 *   transient bridge drop, e.g. a WebView resume) could only ever crash with
 *   the sandbox's "Network access is not allowed". A chain the host does not
 *   advertise stays inert; the merchant fails over to Direct RPC. Standalone
 *   tabs connect via direct WebSocket regardless of the stored transport.
 * - `"rpc"` — failover: bypass the host bridge and connect straight to the
 *   network's public WebSocket RPC endpoints.
 */
import { createPapiProvider } from "@/shared/api/host/host-api.ts";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { createClient, type PolkadotClient } from "polkadot-api";

import { envConfig } from "@/config.ts"
import { getChainTransport } from "@/shared/api/chain-transport.ts";
import { isInHost, requestRemoteOriginPermission } from "@/shared/api/host/connection.ts";
import { sandboxSafeWsConfig } from "@/shared/api/sandbox-safe-websocket.ts";

const clientCache = new Map<string, PolkadotClient>();


export function getOrCreateClient(
  genesis: `0x${string}`,
  wsUrl: string
): PolkadotClient {
  const transport = getChainTransport();
  const cacheKey = `${genesis}:${transport}`;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey)!;
  const provider =
    transport === "rpc" || !isInHost()
      ? getWsProvider(wsUrl, sandboxSafeWsConfig())
      : createPapiProvider(genesis);
  const client = createClient(provider);
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Destroy cached clients built for a transport other than the active one.
 * Called when the merchant switches transport on the Settings page: the
 * settings change restarts the v1/v2 engines, and their fresh
 * `mainChainClient()` / `peopleChainClient()` lookups rebuild on the new
 * transport while this reaps the old connections (dead follows included).
 */
export function dropStaleTransportClients(): void {
  const suffix = `:${getChainTransport()}`;
  for (const [key, client] of clientCache) {
    if (key.endsWith(suffix)) continue;
    try {
      client.destroy();
    } catch {
      // Destroy can throw mid-handshake on the host bridge; eviction below
      // still guarantees the next lookup rebuilds.
    }
    clientCache.delete(key);
  }
}

/** Asset Hub-like main chain client — pallet-revive registry reads (v1 remote). */
export function mainChainClient(): PolkadotClient {
  const { mainChain } = envConfig.network;
  return getOrCreateClient(mainChain.genesisHash as `0x${string}`, mainChain.wsUrl);
}

/**
 * People-system parachain client — `Assets.Transferred` watch + balances.
 * Returns `null` when the active network has no people chain (v1 then surfaces
 * a Notice rather than silently watching nothing).
 */
export function peopleChainClient(): PolkadotClient | null {
  const { peopleChain } = envConfig.network;
  if (!peopleChain) return null;
  return getOrCreateClient(peopleChain.genesisHash as `0x${string}`, peopleChain.wsUrl);
}

/**
 * Drop and recreate the People-chain client. PAPI's `chainHead_v1_follow`
 * lives for the lifetime of the client; if the host suspends and resumes its
 * chain WS without emitting a `Stop` event (observed on iOS host wake), the
 * follow ID held by PAPI is stale and no further blocks surface. Destroying
 * the client tears down the dead follow; recreating forces a fresh
 * `chainHead_v1_follow` on the now-reconnected WS. No-op when no people chain
 * is configured.
 */
export function recreatePeopleChainClient(): PolkadotClient | null {
  const { peopleChain } = envConfig.network;
  if (!peopleChain) return null;
  const key = `${peopleChain.genesisHash}:${getChainTransport()}`;
  const existing = clientCache.get(key);
  if (existing) {
    try {
      existing.destroy();
    } catch {
      // PAPI's destroy can throw when called mid-handshake on the host
      // bridge; the cache eviction below still makes the next lookup recreate.
    }
    clientCache.delete(key);
  }
  return peopleChainClient();
}

/**
 * In-host on the `"rpc"` transport, ask the host to allowlist outbound WS to
 * the configured chain RPC endpoints. No-op standalone and on the `"host"`
 * transport — chain traffic rides the host bridge there, so booting never
 * prompts the merchant for web-domain access; the prompt surfaces exactly
 * when they switch to Direct RPC (and on later boots while it stays active).
 */
export async function requestChainRemotePermissions(): Promise<void> {
  if (!isInHost() || getChainTransport() !== "rpc") return;
  const origins: string[] = [];
  for (const endpoint of [envConfig.network.mainChain, envConfig.network.peopleChain]) {
    if (!endpoint) continue;
    try {
      origins.push(new URL(endpoint.wsUrl).hostname);
    } catch {
      // Malformed wsUrl — skip; the client connect will surface the failure.
    }
  }
  if (origins.length > 0) await requestRemoteOriginPermission([...new Set(origins)]);
}

/** Test / HMR only — drop all cached clients so the next call rebuilds. */
export function resetClientCache(): void {
  clientCache.forEach((client) => client.destroy());
  clientCache.clear();
}
