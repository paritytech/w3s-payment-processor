// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Login-time pull of already-published Z reports. The fiscal store is local KV,
 * so a fresh device (or a reinstall) starts empty even when the group already
 * has reports on-chain: the Reports view looks blank and the next close-out
 * files into an already-claimed seq. This walks the registry's claimed seqs,
 * fetches each missing report's ciphertext from Bulletin via the host preimage
 * lookup, decrypts it with the unlock passkey, and merges it into the store.
 */
import { CID } from "multiformats/cid";

import { loadSavedCreds } from "@/app/unlock-creds.ts";
import { isInHost } from "@/shared/api/host/connection.ts";
import { preimageManager } from "@/shared/api/host/host-api.ts";
import { decryptCredentialEnvelope } from "@/shared/utils/wire/credential-envelope.ts";
import { BLAKE2B_256_CODE, BLAKE2B_256_LENGTH } from "@/shared/utils/wire/cid.ts";
import type { KvStore } from "@/shared/utils/kv-store.ts";
import { appendZReport, clampPeriodStart, saveReportState } from "@/features/v1/api/persistence.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";
import type { ReportPayment, ZReportRecord } from "@/features/v1/types.ts";
import {
  PROCESSOR_REPORT_FORMAT,
  PROCESSOR_REPORT_VERSION,
  type ProcessorReportDoc,
} from "./report-doc.ts";
import { claimedReportSeqs, readProcessorReportSlot } from "./report-storage.ts";

const PREIMAGE_LOOKUP_TIMEOUT_MS = 30_000;

/** Test seams; production callers pass nothing. */
export interface ReportSyncDeps {
  readonly lookupPreimage?: (key: `0x${string}`) => Promise<Uint8Array | null>;
  readonly inHost?: () => boolean;
}

let inFlight: Promise<number> | null = null;

/**
 * Pull this group's on-chain reports into the local fiscal store: reports
 * published by other devices appear in the Reports view, locally-pending
 * reports whose upload already landed flip to `published`, and the seq cursor
 * advances past every claimed slot so the next close-out cannot collide.
 * Concurrent calls share one run. Returns the number of records added or
 * updated.
 */
export function syncPublishedReports(kv: KvStore, deps: ReportSyncDeps = {}): Promise<number> {
  if (inFlight) return inFlight;
  inFlight = runSync(kv, deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(kv: KvStore, deps: ReportSyncDeps): Promise<number> {
  const { groupId, passkey } = loadSavedCreds();
  if (groupId === "" || passkey === "") {
    console.info("[reports] sync: no unlock credentials — skipping published-report pull");
    return 0;
  }

  console.info(`[reports] sync: reading claimed report seqs for ${groupId}…`);
  const claimed = await claimedReportSeqs(groupId);
  console.info(
    `[reports] sync: chain has ${claimed.length} published report(s)` +
      (claimed.length > 0 ? ` (seqs ${claimed.join(", ")})` : ""),
  );
  if (claimed.length === 0) return 0;

  const inHost = deps.inHost ?? isInHost;
  const lookup = deps.lookupPreimage ?? lookupHostPreimage;
  let changed = 0;

  for (const seq of claimed) {
    const local = useV1Store.getState().zReports.find((z) => z.seq === seq);
    if (local?.publishState === "published") continue;
    try {
      changed += await pullSeq({ kv, groupId, passkey, seq, local, inHost, lookup });
    } catch (caught) {
      console.warn(`[reports] sync: pulling seq ${seq} failed — skipping`, caught);
    }
  }

  await advanceSeqCursor(kv, claimed[claimed.length - 1]!);
  console.info(`[reports] sync: done — ${changed} report(s) added or updated`);
  return changed;
}

interface PullSeqArgs {
  readonly kv: KvStore;
  readonly groupId: string;
  readonly passkey: string;
  readonly seq: number;
  readonly local: ZReportRecord | undefined;
  readonly inHost: () => boolean;
  readonly lookup: (key: `0x${string}`) => Promise<Uint8Array | null>;
}

async function pullSeq(args: PullSeqArgs): Promise<number> {
  const slot = await readProcessorReportSlot(
    args.groupId,
    args.seq,
    `report slot sync read (seq ${args.seq})`,
  );
  if (!slot.exists) return 0;

  if (args.local != null) {
    if (slot.cid === args.local.lastAttemptCid) {
      console.info(`[reports] sync: seq ${args.seq} — this device's earlier upload landed; marking published`);
      await persistRecord(args.kv, { ...args.local, publishState: "published", cid: slot.cid });
      return 1;
    }
    console.warn(
      `[reports] sync: seq ${args.seq} is claimed on-chain by ${slot.cid} but a different local report ` +
        "holds that seq — it will re-slot on its next publish",
    );
    return 0;
  }

  if (!args.inHost()) {
    console.warn(`[reports] sync: seq ${args.seq} needs a host preimage lookup — skipping in standalone mode`);
    return 0;
  }

  const key = preimageKeyFromCid(slot.cid);
  if (key == null) {
    console.warn(`[reports] sync: seq ${args.seq} cid ${slot.cid} is not a Bulletin blake2b-256 cid — skipping`);
    return 0;
  }

  console.info(`[reports] sync: seq ${args.seq} — fetching preimage ${key}…`);
  const bytes = await args.lookup(key);
  if (bytes == null) {
    console.warn(
      `[reports] sync: seq ${args.seq} preimage ${key} not found on Bulletin (expired or not yet synced) — skipping`,
    );
    return 0;
  }

  const doc = await decryptReportDoc(bytes, args.passkey, args.groupId, args.seq);
  await persistRecord(args.kv, docToRecord(doc, args.seq, slot.cid));
  console.info(`[reports] sync: seq ${args.seq} pulled into the local store (cid ${slot.cid})`);
  return 1;
}

/**
 * The host pushes `null` while the preimage is not in its local cache yet and
 * follows up once the Bulletin fetch completes — only a non-null payload (or
 * the timeout) is a final answer.
 */
function lookupHostPreimage(key: `0x${string}`): Promise<Uint8Array | null> {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array | null>();
  const timer = setTimeout(() => {
    subscription.unsubscribe();
    resolve(null);
  }, PREIMAGE_LOOKUP_TIMEOUT_MS);
  const subscription = preimageManager.lookup(key, (preimage) => {
    if (preimage == null) {
      console.info(`[reports] sync: preimage ${key} not in the host cache yet — waiting for the Bulletin fetch…`);
      return;
    }
    clearTimeout(timer);
    resolve(preimage);
    queueMicrotask(() => subscription.unsubscribe());
  });
  subscription.onInterrupt(() => {
    clearTimeout(timer);
    reject(new Error(`preimage lookup ${key} was interrupted by the host`));
  });
  return promise;
}

function preimageKeyFromCid(cid: string): `0x${string}` | null {
  try {
    const { code, digest } = CID.parse(cid).multihash;
    if (code !== BLAKE2B_256_CODE || digest.length !== BLAKE2B_256_LENGTH) return null;
    let hex = "0x";
    for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
    return hex as `0x${string}`;
  } catch {
    return null;
  }
}

async function decryptReportDoc(
  bytes: Uint8Array,
  passkey: string,
  groupId: string,
  seq: number,
): Promise<ProcessorReportDoc> {
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const plaintext = await decryptCredentialEnvelope(envelope, passkey);
  const doc = JSON.parse(new TextDecoder().decode(plaintext)) as ProcessorReportDoc;
  if (doc.format !== PROCESSOR_REPORT_FORMAT || doc.version !== PROCESSOR_REPORT_VERSION) {
    throw new Error(`unexpected report doc format ${String(doc.format)} v${String(doc.version)}`);
  }
  if (doc.kind !== "z" || doc.seq !== seq || doc.groupId !== groupId) {
    throw new Error(`report doc mismatch: kind ${doc.kind}, seq ${String(doc.seq)}, groupId ${doc.groupId}`);
  }
  return doc;
}

function docToRecord(doc: ProcessorReportDoc, seq: number, cid: string): ZReportRecord {
  const payments: ReportPayment[] = doc.payments.map(({ amount: _formatted, ...payment }) => payment);
  return {
    fromBlock: doc.fromBlock,
    toBlock: doc.toBlock,
    lines: doc.lines,
    grandTotalPlanck: doc.grandTotalPlanck,
    count: doc.count,
    payments,
    seq,
    committedAtMs: doc.generatedAtMs,
    source: railSource(payments),
    publishState: "published",
    cid,
  };
}

/** RFC-6 (v1) payments carry a block number; coin (v2) payments never do. */
function railSource(payments: readonly ReportPayment[]): ZReportRecord["source"] {
  const withBlock = payments.filter((payment) => payment.blockNumber != null).length;
  if (withBlock === 0) return payments.length === 0 ? "v1" : "v2";
  return withBlock === payments.length ? "v1" : "mixed";
}

async function persistRecord(kv: KvStore, record: ZReportRecord): Promise<void> {
  await appendZReport(kv, record);
  const { zReports } = useV1Store.getState();
  const others = zReports.filter((z) => z.seq !== record.seq);
  useV1Store.setState({ zReports: [...others, record].sort((a, b) => a.seq - b.seq) });
}

async function advanceSeqCursor(kv: KvStore, highestClaimed: number): Promise<void> {
  const { reportState, zReports } = useV1Store.getState();
  const lastZSeq = Math.max(reportState.lastZSeq, highestClaimed);
  const nextState = clampPeriodStart({ ...reportState, lastZSeq }, zReports);
  if (nextState.lastZSeq === reportState.lastZSeq && nextState.periodStartBlock === reportState.periodStartBlock) {
    return;
  }
  await saveReportState(kv, nextState);
  useV1Store.setState({ reportState: nextState });
  console.info(
    `[reports] sync: report cursor advanced (lastZSeq ${nextState.lastZSeq}, periodStartBlock ${nextState.periodStartBlock})`,
  );
}
