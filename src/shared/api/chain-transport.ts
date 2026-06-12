// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Chain transport selection — how PAPI JSON-RPC reaches the chains.
 *
 * - `"host"` — in-host, route through the Polkadot host bridge
 *   (`createPapiProvider`) with no WebSocket fallback (the sandbox denies
 *   non-allowlisted origins); standalone tabs connect via direct WebSocket.
 * - `"rpc"` — bypass the host bridge and connect straight to the public
 *   WebSocket RPC endpoints from `networks.ts`.
 *
 * The merchant picks this on the Settings page as a failover: if the host's
 * chain connection is down they switch to direct RPC, and vice versa. The
 * choice persists locally (same trust model as the protocol toggles) and is
 * read synchronously by `shared/api/client.ts` at client-creation time, so
 * it lives outside React context.
 */

export type ChainTransport = "host" | "rpc";

export const DEFAULT_CHAIN_TRANSPORT: ChainTransport = "host";

const STORAGE_KEY = "w3spay-chain-transport:v1";

let current: ChainTransport | null = null;

/** Active transport. Lazily hydrates from localStorage on first call. */
export function getChainTransport(): ChainTransport {
  if (current) return current;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    current = stored === "host" || stored === "rpc" ? stored : DEFAULT_CHAIN_TRANSPORT;
  } catch {
    // No localStorage (SSR / Node tests) or sandboxed storage — default.
    current = DEFAULT_CHAIN_TRANSPORT;
  }
  return current;
}

/**
 * Persist + apply a transport choice. Takes effect for clients created from
 * now on — callers that hold live clients must rebuild them (see
 * `dropStaleTransportClients` in `shared/api/client.ts`).
 */
export function setChainTransport(transport: ChainTransport): void {
  current = transport;
  try {
    localStorage.setItem(STORAGE_KEY, transport);
  } catch {
    /* ignore storage failures (private mode / sandbox) */
  }
}

/** Test / HMR only — drop the memoized value so the next read re-hydrates. */
export function resetChainTransportCache(): void {
  current = null;
}
