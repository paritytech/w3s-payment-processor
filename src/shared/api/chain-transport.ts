// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Chain transport selection — how PAPI JSON-RPC reaches the chains.
 *
 * - `"host"` — route through the Polkadot host bridge (`createPapiProvider`),
 *   with the direct WebSocket provider as the SDK-level fallback when the
 *   host does not advertise the requested chain (and in standalone tabs).
 * - `"rpc"` — bypass the host bridge and connect straight to the public
 *   WebSocket RPC endpoints from `networks.ts`.
 *
 * The merchant picks this on the Settings page as a failover: if the host's
 * chain connection is down they switch to direct RPC, and vice versa. The
 * choice persists locally (same trust model as the protocol toggles) and is
 * read synchronously by `shared/api/client.ts` at client-creation time, so
 * it lives outside React context.
 */

import { captureWarning } from "@/shared/utils/telemetry/helpers.ts";

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
  const from = getChainTransport();
  current = transport;
  try {
    localStorage.setItem(STORAGE_KEY, transport);
  } catch {
    /* ignore storage failures (private mode / sandbox) */
  }
  // A host→rpc (or rpc→host) switch is a manual failover — the active chain
  // link is degraded. Surface it as a reliability signal.
  if (from !== transport) {
    captureWarning("chain transport failover", { from, to: transport });
  }
}

/** Test / HMR only — drop the memoized value so the next read re-hydrates. */
export function resetChainTransportCache(): void {
  current = null;
}
