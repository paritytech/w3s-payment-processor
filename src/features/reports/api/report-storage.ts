// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech


import type { PolkadotSigner } from "polkadot-api";

import { envConfig } from "@/config.ts";
import { isInHost, requestRemotePermission } from "@/shared/api/host/connection.ts";
import { preimageManager } from "@/shared/api/host/host-api.ts";
import { mainChainClient } from "@/shared/api/client.ts";
import { writeContract } from "@/shared/api/contracts/write-contract.ts";
import { readContract } from "@/shared/api/contracts/read.ts";
import type { TxStatus } from "@/shared/api/contracts/watch-transaction.ts";
import { withTimeout } from "@/shared/api/contracts/with-timeout.ts";
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
export interface RawProcessorReportRecord {
  readonly seq: bigint;
  readonly cid: string;
  readonly size: number;
  readonly committedAt: bigint;
  readonly exists: boolean;
}

/** Chain reads through the host bridge can wedge silently when the bridge is
 *  reconnecting — bound them so a stuck publish surfaces as a labeled error
 *  instead of an eternal "Publishing…" spinner. */
const SLOT_READ_TIMEOUT_MS = 15_000;
/** Host-side Bulletin upload (authorization + submission). Generous — matches
 *  the post-broadcast stall budget in watch-transaction. */
const PREIMAGE_SUBMIT_TIMEOUT_MS = 120_000;

export async function publishZReport(opts: PublishZReportOptions): Promise<PublishZReportResult> {
  console.info(
    `[reports] publish: start (groupId ${opts.groupId}, seq ${opts.record.seq}, lastAttemptCid ${opts.lastAttemptCid ?? "none"})`,
  );
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
  console.info("[reports] publish: report encoded", {
    seq: opts.record.seq,
    plaintextBytes: plaintext.length,
    envelopeBytes: bytes.length,
    cid: uploadedCid,
  });

  const registryAddress = envConfig.remoteCredentials.registryAddress.toLowerCase() as `0x${string}`;
  const client = mainChainClient();
  const readSlot = (label: string): Promise<RawProcessorReportRecord> =>
    readProcessorReportSlot(opts.groupId, opts.record.seq, label);

  console.info(`[reports] publish: pre-check read of slot (${opts.groupId}, ${opts.record.seq})…`);
  try {
    const existing = await readSlot("report slot pre-check read");
    if (existing.exists) {
      if (existing.cid === uploadedCid || (opts.lastAttemptCid != null && existing.cid === opts.lastAttemptCid)) {
        console.info(`[reports] publish: slot already holds this device's upload ${existing.cid} — reusing it`);
        return { cid: existing.cid, size: existing.size };
      }
      throw new ReportConflictError(
        `report seq ${opts.record.seq}: on-chain slot already holds ${existing.cid}, ` +
          `which is not this device's previous upload`,
      );
    }
    console.info(`[reports] publish: slot ${opts.record.seq} is free`);
  } catch (caught) {
    if (caught instanceof ReportConflictError) throw caught;
    console.warn("[reports] publish pre-check read failed (continuing to write)", caught);
  }

  console.info("[reports] publish: checking PreimageSubmit permission (may pop a host modal)…");
  const preimagePermission = await requestRemotePermission("PreimageSubmit");
  if (!preimagePermission.granted) {
    throw new Error(
      "The host did not grant the PreimageSubmit permission" +
        (preimagePermission.error ? ` (${preimagePermission.error})` : "") +
        " — approve it in the Polkadot app, then retry the publish.",
    );
  }

  const submitter = opts.preimage ?? preimageManager;
  console.info(`[reports] publish: submitting ${bytes.length}-byte preimage to the host (Bulletin upload)…`);
  let preimageKey: `0x${string}`;
  try {
    preimageKey = await withTimeout(submitter.submit(bytes), PREIMAGE_SUBMIT_TIMEOUT_MS, "host preimage submit");
  } catch (caught) {
    throw new Error(`Host rejected preimage submit: ${formatPreimageError(caught)}`, {
      cause: caught,
    });
  }
  console.info(`[reports] publish: preimage accepted, key ${preimageKey}`);

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
  console.info("[reports] publish: checking ChainSubmit permission (may pop a host modal)…");
  const chainPermission = await requestRemotePermission("ChainSubmit");
  if (!chainPermission.granted) {
    throw new Error(
      "The host did not grant the ChainSubmit permission" +
        (chainPermission.error ? ` (${chainPermission.error})` : "") +
        " — approve it in the Polkadot app, then retry the publish.",
    );
  }

  console.info(
    `[reports] publish: writing addProcessorReport(${opts.groupId}, ${opts.record.seq}, ${uploadedCid}, ${size})…`,
  );
  await writeContract(client, {
    address: registryAddress,
    abi: W3SPayRegistryABI,
    functionName: "addProcessorReport",
    args: [opts.groupId, BigInt(opts.record.seq), uploadedCid, size],
    signer: opts.signer,
    walletAddress: opts.walletAddress,
    onStatus: (status: TxStatus) => {
      console.info(`[reports] publish: registry write status → ${status}`);
      opts.onStatus?.(status);
    },

    waitForChainEffect: async () => {
      const slot = await readSlot("chain-effect probe read");
      return slot.exists && slot.cid === uploadedCid;
    },
  });
  console.info("[reports] publish: registry write landed — verifying the slot cid");

  // Read-back guard: confirm our cid won the (groupId, seq) slot. A pre-emptive
  // write with a different cid surfaces here as a conflict (records are
  // immutable; an identical-cid retry is a contract-side no-op and matches).
  const onChain = await readSlot("report slot read-back");
  if (!onChain.exists || onChain.cid !== uploadedCid) {
    throw new ReportConflictError(
      `report seq ${opts.record.seq}: on-chain cid ${onChain.cid || "(none)"} ` +
        `does not match the uploaded ${uploadedCid}`,
    );
  }

  console.info(`[reports] publish: seq ${opts.record.seq} published, cid ${uploadedCid}`);
  return { cid: uploadedCid, size };
}

/**
 * Every report seq with a committed on-chain record for `groupId`, ascending.
 * The login-time sync walks this to pull reports published by other devices.
 */
export async function claimedReportSeqs(groupId: string): Promise<number[]> {
  const registryAddress = envConfig.remoteCredentials.registryAddress.toLowerCase() as `0x${string}`;
  const seqs = await withTimeout(
    readContract<readonly bigint[]>(mainChainClient(), {
      address: registryAddress,
      abi: W3SPayRegistryABI,
      functionName: "getProcessorReportSeqs",
      args: [groupId],
      origin: envConfig.readOnlyOrigin,
      at: "best",
    }),
    SLOT_READ_TIMEOUT_MS,
    "claimed report seqs read",
  );
  return [...new Set(seqs.map((seq) => Number(seq)))].sort((a, b) => a - b);
}

/**
 * Highest report seq with a committed on-chain record for `groupId` (0 when
 * none) — the re-slot cursor when a conflicted report moves to a free slot.
 */
export async function highestClaimedReportSeq(groupId: string): Promise<number> {
  const seqs = await claimedReportSeqs(groupId);
  return seqs.length === 0 ? 0 : seqs[seqs.length - 1]!;
}

/** Decoded on-chain `(groupId, seq)` slot — the `getProcessorReport` tuple. */
export async function readProcessorReportSlot(
  groupId: string,
  seq: number,
  label: string,
): Promise<RawProcessorReportRecord> {
  const registryAddress = envConfig.remoteCredentials.registryAddress.toLowerCase() as `0x${string}`;
  const [onChain] = await withTimeout(
    readContract<[RawProcessorReportRecord]>(mainChainClient(), {
      address: registryAddress,
      abi: W3SPayRegistryABI,
      functionName: "getProcessorReport",
      args: [groupId, BigInt(seq)],
      origin: envConfig.readOnlyOrigin,
      at: "best",
    }),
    SLOT_READ_TIMEOUT_MS,
    label,
  );
  return onChain;
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
