// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Network registry. Source of truth for per-network chain endpoints. The
 * active network is chosen at deploy time via `VITE_NETWORK`; `resolveNetwork`
 * throws on unknown keys so a misconfigured deploy fails loudly at boot.
 *
 * - `mainChain` — Asset Hub-like parachain where the pallet-revive
 *   `W3SPayRegistry` lives (v1 remote registry reads).
 * - `peopleChain` — People-system parachain where the W3T/CASH foreign asset
 *   lives (`pallet-assets`): the v1 `Assets.Transferred` watch + balance reads.
 *
 * Trimmed from `apps/w3spay-admin/src/shared/api/host/networks.ts`; genesis
 * hashes mirror that registry (verified live against the running chains).
 */
export type NetworkKey = "paseo" | "paseo-next-v2" | "previewnet";

export const SUPPORTED_NETWORKS: NetworkKey[] = ["paseo", "paseo-next-v2", "previewnet"];

/**
 * Coinage + Paseo People Next only exist on paseo-next-v2; default there so a
 * bare build targets the network the processor actually monitors.
 */
export const DEFAULT_NETWORK: NetworkKey = "paseo-next-v2";

export interface ChainEndpoint {
  /** WebSocket RPC URL for direct (standalone) connection. */
  wsUrl: string;
  /** Genesis hash — PAPI client cache key + host `createPapiProvider` chain id. */
  genesisHash: `0x${string}` | "";
}

export interface NetworkConfig {
  key: NetworkKey;
  displayName: string;
  isTestnet: boolean;
  /** Asset Hub-like parachain — pallet-revive registry contracts. */
  mainChain: ChainEndpoint;
  /** People-system parachain — W3T/CASH foreign asset. null ⇒ unavailable. */
  peopleChain: ChainEndpoint | null;
}

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  paseo: {
    key: "paseo",
    displayName: "Paseo Asset Hub",
    isTestnet: true,
    mainChain: {
      wsUrl: "wss://asset-hub-paseo.ibp.network",
      genesisHash: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
    },
    peopleChain: null,
  },
  "paseo-next-v2": {
    key: "paseo-next-v2",
    displayName: "Paseo Next V2",
    isTestnet: true,
    mainChain: {
      wsUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io",
      genesisHash: "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f",
    },
    peopleChain: {
      wsUrl: "wss://paseo-people-next-system-rpc.polkadot.io",
      genesisHash: "0xc5af1826b31493f08b7e2a823842f98575b806a784126f28da9608c68665afa5",
    },
  },
  previewnet: {
    key: "previewnet",
    displayName: "Previewnet (substrate.dev)",
    isTestnet: true,
    mainChain: {
      wsUrl: "wss://previewnet.substrate.dev/asset-hub",
      genesisHash: "0x29f7b15e6227f86b90bf5199b5c872c28649a30e5f15fae6dd8fa9d5d48d6fbb",
    },
    peopleChain: null,
  },
};

export function parseNetworkKey(value: string | undefined | null): NetworkKey | null {
  if (!value) return null;
  return (SUPPORTED_NETWORKS as string[]).includes(value) ? (value as NetworkKey) : null;
}

/** Resolve a network key to its config; throws on unknown so deploys fail loud. */
export function resolveNetwork(key: string | undefined | null): NetworkConfig {
  if (!key) return NETWORKS[DEFAULT_NETWORK];
  const parsed = parseNetworkKey(key);
  if (!parsed) {
    throw new Error(`Unknown network "${key}". Valid values: ${SUPPORTED_NETWORKS.join(", ")}`);
  }
  return NETWORKS[parsed];
}
