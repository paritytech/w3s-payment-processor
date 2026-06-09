// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech


import type { PolkadotSigner } from "polkadot-api";

import { envConfig } from "@/config.ts";
import { isInHost } from "@/shared/api/host/connection.ts";
import { preimageManager } from "@/shared/api/host/host-api.ts";
import { mainChainClient } from "@/shared/api/client.ts";
import { writeContract } from "@/shared/api/contracts/write-contract.ts";
import { readContract } from "@/shared/api/contracts/read.ts";
import type { TxStatus } from "@/shared/api/contracts/watch-transaction.ts";
import { W3SPayRegistryABI } from "@/features/v1/api/registry-abi.ts";
import { encryptCredentialEnvelope } from "@/shared/utils/wire/credential-envelope.ts";
import { buildReportDoc } from "@/features/reports/api/report-doc.ts";
import {
  BLAKE2B_256_LENGTH,
  calculateBulletinCidObject,
} from "@/shared/utils/wire/cid.ts";
import type { ZReportRecord } from "@/features/v1/types.ts";

/** Thrown when the on-chain `(groupId, seq)` slot holds a cid other than ours
 *  (a front-run / griefing write pre-empted the seq). The UI marks the report
 *  `conflict`; the encrypted report is unreadable to the front-runner. */
export class ReportConflictError extends Error {
  override readonly name = "ReportConflictError";
}

/** Minimal contract the publish flow needs — matches `preimageManager.submit`. */
export interface PreimageSubmitter {
  submit(value: Uint8Array): Promise<`0x${string}`>;
}

export interface PublishZReportOptions {
  readonly groupId: string;
  readonly record: ZReportRecord;
  readonly passkey: string;
  readonly signer: PolkadotSigner;
  readonly walletAddress: string;
  readonly lastAttemptCid?: string;
  readonly onPreimageUploaded?: (cid: string) => void | Promise<void>;
  readonly preimage?: PreimageSubmitter;
  readonly inHost?: () => boolean;
  readonly onStatus?: (status: TxStatus) => void;
}

export interface PublishZReportResult {
  readonly cid: string;
  readonly size: number;
}

/** Decoded `getProcessorReport` tuple — mirrors the Solidity `ProcessorReportRecord`. */
interface RawProcessorReportRecord {
  readonly seq: bigint;
  readonly cid: string;
  readonly size: number;
  readonly committedAt: bigint;
  readonly exists: boolean;
}

export async function publishZReport(opts: PublishZReportOptions): Promise<PublishZReportResult> {
  const inHost = opts.inHost ?? isInHost;
  if (!inHost()) {
    throw new Error(
      "Publishing a report requires a host environment (Polkadot Desktop / dotli) so the host " +
        "can sign the preimage submit and the registry write on your behalf.",
    );
  }

  const doc = buildReportDoc({
    kind: "z",
    groupId: opts.groupId,
    snapshot: opts.record,
    seq: opts.record.seq,
    generatedAtMs: opts.record.committedAtMs,
  });
  const plaintext = new TextEncoder().encode(JSON.stringify(doc));
  const envelope = await encryptCredentialEnvelope(plaintext, opts.passkey);

  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const cidObj = calculateBulletinCidObject(bytes);
  const uploadedCid = cidObj.toString();

  const registryAddress = envConfig.remoteCredentials.registryAddress.toLowerCase() as `0x${string}`;
  const client = mainChainClient();
  const readSlot = async (): Promise<RawProcessorReportRecord> => {
    const [onChain] = await readContract<[RawProcessorReportRecord]>(client, {
      address: registryAddress,
      abi: W3SPayRegistryABI,
      functionName: "getProcessorReport",
      args: [opts.groupId, BigInt(opts.record.seq)],
      origin: envConfig.readOnlyOrigin,
      at: "best",
    });
    return onChain;
  };

  try {
    const existing = await readSlot();
    if (existing.exists) {
      if (existing.cid === uploadedCid || (opts.lastAttemptCid != null && existing.cid === opts.lastAttemptCid)) {
        return { cid: existing.cid, size: existing.size };
      }
      throw new ReportConflictError(
        `report seq ${opts.record.seq}: on-chain slot already holds ${existing.cid}, ` +
          `which is not this device's previous upload`,
      );
    }
  } catch (caught) {
    if (caught instanceof ReportConflictError) throw caught;
    console.warn("[reports] publish pre-check read failed (continuing to write)", caught);
  }

  const submitter = opts.preimage ?? preimageManager;
  let preimageKey: `0x${string}`;
  try {
    preimageKey = await submitter.submit(bytes);
  } catch (caught) {
    throw new Error(`Host rejected preimage submit: ${formatPreimageError(caught)}`, {
      cause: caught,
    });
  }

  const expectedDigest = cidObj.multihash.digest;
  const actualDigest = hexToBytes(preimageKey);
  if (!digestsMatch(expectedDigest, actualDigest)) {
    throw new Error(
      `Host preimage key ${preimageKey} does not match expected blake2b-256 digest ` +
        `${bytesToHex(expectedDigest)} for the encoded report; refusing to record a mismatched CID.`,
    );
  }

  await opts.onPreimageUploaded?.(uploadedCid);

  const size = bytes.length;
  await writeContract(client, {
    address: registryAddress,
    abi: W3SPayRegistryABI,
    functionName: "addProcessorReport",
    args: [opts.groupId, BigInt(opts.record.seq), uploadedCid, size],
    signer: opts.signer,
    walletAddress: opts.walletAddress,
    onStatus: opts.onStatus,

    waitForChainEffect: async () => {
      const slot = await readSlot();
      return slot.exists && slot.cid === uploadedCid;
    },
  });

  // Read-back guard: confirm our cid won the (groupId, seq) slot. A pre-emptive
  // write with a different cid surfaces here as a conflict (records are
  // immutable; an identical-cid retry is a contract-side no-op and matches).
  const onChain = await readSlot();
  if (!onChain.exists || onChain.cid !== uploadedCid) {
    throw new ReportConflictError(
      `report seq ${opts.record.seq}: on-chain cid ${onChain.cid || "(none)"} ` +
        `does not match the uploaded ${uploadedCid}`,
    );
  }

  return { cid: uploadedCid, size };
}

function formatPreimageError(err: unknown): string {
  if (err == null) return "unknown error";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "reason" in err && typeof (err as { reason: unknown }).reason === "string") {
    return (err as { reason: string }).reason;
  }
  return String(err);
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const stripped = hex.slice(2);
  if (stripped.length % 2 !== 0) throw new Error(`Odd-length hex string returned by host: ${hex}`);
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(stripped.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i]! < 0x10 ? "0" : "") + bytes[i]!.toString(16);
  }
  return hex as `0x${string}`;
}

function digestsMatch(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== BLAKE2B_256_LENGTH || b.length !== BLAKE2B_256_LENGTH) return false;
  for (let i = 0; i < BLAKE2B_256_LENGTH; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
