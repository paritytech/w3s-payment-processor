// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Generic contract write over pallet-revive. Vendored from
 * `apps/w3spay-admin/src/shared/chain/contracts/write-contract.ts`, adapted to
 * viem (this app's ABI codec — see `read.ts`) instead of ethers: encode via
 * `encodeFunctionData`, decode dry-run reverts via `decodeErrorResult`.
 *
 * Flow: encode → (if mapped) dry-run for weight/storage + revert detection →
 * `Revive.map_account` on first write → `Revive.call` + `watchTransaction`.
 */
import { decodeErrorResult, encodeFunctionData, type Abi } from "viem";
import { Binary, type PolkadotClient, type PolkadotSigner } from "polkadot-api";

import { isAccountMapped } from "./account-mapping.ts";
import { reviveApi, stringifyResultValue } from "./read.ts";
import {
  watchTransaction,
  type ChainEffectOracle,
  type TxStatus,
  type WatchableTx,
} from "./watch-transaction.ts";
import { withTimeout } from "./with-timeout.ts";

interface ReviveTxShim {
  call(params: {
    dest: string;
    value: bigint;
    weight_limit: { ref_time: bigint; proof_size: bigint };
    storage_deposit_limit: bigint;
    data: Uint8Array;
  }): WatchableTx;
  map_account(): WatchableTx;
}

function reviveTx(unsafeApi: unknown): ReviveTxShim {
  return (unsafeApi as { tx: { Revive: ReviveTxShim } }).tx.Revive;
}

/** `AccountAlreadyMapped` is benign — swallow it and proceed. */
function isAlreadyMappedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /AccountAlreadyMapped/i.test(message);
}

function decodeDryRunRevertReason(abi: Abi, data: `0x${string}`): string | null {
  if (data === "0x") return null;
  try {
    const decoded = decodeErrorResult({ abi, data });
    const args = decoded.args ?? [];
    if (decoded.errorName === "Error" && args.length === 1) {
      return String(args[0]);
    }
    const rendered = Array.from(args, (v) => (typeof v === "bigint" ? v.toString() : String(v))).join(", ");
    return rendered === "" ? decoded.errorName : `${decoded.errorName}(${rendered})`;
  } catch {
    // Fall through — undecodable revert data.
    return null;
  }
}

function dryRunRevertMessage(abi: Abi, functionName: string, data: Uint8Array): string {
  const revertHex = Binary.toHex(data) as `0x${string}`;
  const reason = decodeDryRunRevertReason(abi, revertHex);
  if (reason != null && reason !== "") {
    return `contract ${functionName} dry-run reverted: ${reason}`;
  }
  return revertHex === "0x"
    ? `contract ${functionName} dry-run reverted`
    : `contract ${functionName} dry-run reverted (data=${revertHex})`;
}

const WEIGHT_MULTIPLIER_NUM = 3n;
const WEIGHT_MULTIPLIER_DEN = 2n;
const STORAGE_MULTIPLIER_NUM = 5n;
const STORAGE_MULTIPLIER_DEN = 4n;

const DRY_RUN_STORAGE_DEPOSIT = 500_000_000_000n;
const DRY_RUN_TIMEOUT_MS = 20_000;

const FALLBACK_WEIGHT_LIMIT = { ref_time: 500_000_000_000n, proof_size: 3_000_000n };
const FALLBACK_STORAGE_DEPOSIT = 50_000_000_000n;

export interface WriteContractOptions {
  readonly address: `0x${string}`;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
  readonly value?: bigint;
  readonly signer: PolkadotSigner;
  /** SS58 wallet address — used as dry-run origin and mapping check. */
  readonly walletAddress: string;
  readonly onStatus?: (status: TxStatus) => void;
  /**
   * Optional inclusion oracle for the contract call (NOT for the
   * `Revive.map_account` pre-step, which uses `isAccountMapped` internally).
   * Polled after `broadcasted` to detect inclusion via state read — workaround
   * for chains whose host-bridge `chainHead` follow never delivers
   * `txBestBlocksState`.
   */
  readonly waitForChainEffect?: ChainEffectOracle;
}

export async function writeContract(
  client: PolkadotClient,
  options: WriteContractOptions,
): Promise<`0x${string}`> {
  const { address, abi, functionName, args = [], value, signer, walletAddress, onStatus } = options;

  onStatus?.("preparing");

  const calldata = encodeFunctionData({ abi, functionName, args: args as unknown[] }) as `0x${string}`;
  const unsafeApi = client.getUnsafeApi();
  const destLower = address.toLowerCase() as `0x${string}`;
  const txValue = value ?? 0n;

  const isMapped = await isAccountMapped(client, walletAddress);

  let weightLimit: { ref_time: bigint; proof_size: bigint } | undefined;
  let storageDepositLimit: bigint | undefined;
  let dryRunRevertError: string | null = null;
  if (isMapped) {
    try {
      const dryRun = await withTimeout(
        reviveApi(unsafeApi).call(
          walletAddress,
          destLower,
          txValue,
          undefined,
          DRY_RUN_STORAGE_DEPOSIT,
          Binary.fromHex(calldata),
        ),
        DRY_RUN_TIMEOUT_MS,
        `${functionName} dry-run`,
      );
      if (dryRun.result.success && (dryRun.result.value.flags & 1) === 0) {
        weightLimit = {
          ref_time: (dryRun.weight_required.ref_time * WEIGHT_MULTIPLIER_NUM) / WEIGHT_MULTIPLIER_DEN,
          proof_size: (dryRun.weight_required.proof_size * WEIGHT_MULTIPLIER_NUM) / WEIGHT_MULTIPLIER_DEN,
        };
        storageDepositLimit =
          dryRun.storage_deposit.value > 0n
            ? (dryRun.storage_deposit.value * STORAGE_MULTIPLIER_NUM) / STORAGE_MULTIPLIER_DEN
            : DRY_RUN_STORAGE_DEPOSIT;
      } else if (dryRun.result.success) {
        dryRunRevertError = dryRunRevertMessage(abi, functionName, dryRun.result.value.data);
      } else {
        dryRunRevertError = `contract ${functionName} dry-run failed: ${stringifyResultValue(
          dryRun.result.value,
        )}`;
      }
    } catch (caught) {
      console.warn(
        `[writeContract] ${functionName} dry-run threw; using conservative estimates:`,
        caught,
      );
    }
  }

  if (dryRunRevertError != null) {
    throw new Error(dryRunRevertError);
  }

  if (weightLimit == null || storageDepositLimit == null) {
    weightLimit = FALLBACK_WEIGHT_LIMIT;
    storageDepositLimit = FALLBACK_STORAGE_DEPOSIT;
  }

  const contractCall = reviveTx(unsafeApi).call({
    dest: destLower,
    value: txValue,
    weight_limit: weightLimit,
    storage_deposit_limit: storageDepositLimit,
    data: Binary.fromHex(calldata),
  });

  // The first write from a fresh product account MUST map it once. Subsequent
  // writes skip this path after `OriginalAccount` exists.
  if (!isMapped) {
    try {
      await watchTransaction(reviveTx(unsafeApi).map_account(), signer, onStatus, {
        waitForChainEffect: () => isAccountMapped(client, walletAddress),
      });
    } catch (caught) {
      if (!isAlreadyMappedError(caught)) throw caught;
    }
  }

  return watchTransaction(contractCall, signer, onStatus, {
    waitForChainEffect: options.waitForChainEffect,
  });
}
