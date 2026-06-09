// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * v1 terminal resolution. Local mode synthesizes terminals from config; remote
 * mode reads the on-chain `W3SPayRegistry` and filters by `groupId`
 * (which maps to the registry's `merchantId` — the registry has no separate
 * group field). Revoked terminals are dropped; active + paused are watched.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import type { PolkadotClient } from "polkadot-api";

import { readContract } from "@/shared/api/contracts/read.ts";
import { accountId32ToSs58, type AccountId32Hex } from "@/shared/utils/address.ts";
import { W3SPayRegistryABI } from "@/features/v1/api/registry-abi.ts";
import type { ResolvedV1Mode } from "@/config.ts"
import type { TerminalStatus, V1Terminal } from "@/features/v1/types.ts";

interface RawMerchantEntry {
  readonly merchantId: string;
  readonly terminalId: string;
  readonly destinationAccountId: `0x${string}`;
  readonly displayName: string;
  readonly status: number;
  readonly addedAt: bigint;
  readonly updatedAt: bigint;
  readonly exists: boolean;
}

/** Read the registry and return the active/paused terminals whose merchantId === groupId. */
export async function listTerminalsForGroup(
  client: PolkadotClient,
  registryAddress: `0x${string}`,
  groupId: string,
  origin: string,
): Promise<V1Terminal[]> {
  const keys = await readContract<readonly `0x${string}`[]>(client, {
    address: registryAddress,
    abi: W3SPayRegistryABI,
    functionName: "getAllTerminalKeys",
    origin,
    at: "best",
  });

  const resolved = await Promise.all(
    keys.map(async (key): Promise<V1Terminal | null> => {
      const [entry] = await readContract<[RawMerchantEntry]>(client, {
        address: registryAddress,
        abi: W3SPayRegistryABI,
        functionName: "getMerchantByKey",
        args: [key],
        origin,
        at: "best",
      });
      if (!entry.exists || entry.merchantId !== groupId) return null;
      const status: TerminalStatus =
        entry.status === 0 ? "active" : entry.status === 1 ? "paused" : "revoked";
      if (status === "revoked") return null;
      const accountId32 = hexToBytes(entry.destinationAccountId.slice(2));
      return {
        terminalId: entry.terminalId,
        displayName: entry.displayName,
        status,
        payout: {
          accountId32,
          ss58: accountId32ToSs58(accountId32),
          hex: entry.destinationAccountId.toLowerCase() as AccountId32Hex,
        },
      };
    }),
  );

  return resolved.filter((terminal): terminal is V1Terminal => terminal != null);
}

/**
 * Resolve v1 terminals for either mode. `getClient` is invoked ONLY in remote
 * mode — local mode must never create the main-chain client, since spinning up
 * a second host-bridge client can clobber the People-chain connection through
 * the host-api wrapper's shared transport singleton.
 */
export async function resolveV1Terminals(
  mode: ResolvedV1Mode,
  getClient: () => PolkadotClient,
  origin: string,
): Promise<V1Terminal[]> {
  if (mode.kind === "local") {
    return mode.terminals.map((terminal) => ({
      terminalId: terminal.terminalId,
      displayName: terminal.displayName,
      payout: terminal.payout,
    }));
  }
  return listTerminalsForGroup(getClient(), mode.merchantRegistryAddress, mode.groupId, origin);
}
