// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { envConfig } from "@/config.ts";
import { loadSavedCreds } from "@/app/unlock-creds.ts";
import { getProductAccountSigner, resolveHostProductAccount } from "@/shared/api/host/accounts.ts";
import type { TxStatus } from "@/shared/api/contracts/watch-transaction.ts";
import { withTimeout } from "@/shared/api/contracts/with-timeout.ts";
import type { KvStore } from "@/shared/utils/kv-store.ts";
import { appendZReport, reslotZReport, saveReportState } from "@/features/v1/api/persistence.ts";
import type { ReportState, ZReportRecord } from "@/features/v1/types.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";
import { highestClaimedReportSeq, publishZReport, ReportConflictError } from "./report-storage.ts";

/** Resolves with the published record — re-slotted under a new seq when the
 *  original on-chain slot was claimed by another writer. */
export type ZReportPublish = (seq: number, onStatus?: (status: TxStatus) => void) => Promise<ZReportRecord>;

/** Conflict → re-slot cycles per publish call. Each cycle jumps past every
 *  claimed seq we can see, so >1 only happens when writers keep racing us. */
const MAX_SLOT_REBASES = 4;

/** Host account RPC is a bare promise — bound it so a wedged bridge surfaces
 *  as an error instead of an eternal "Publishing…" spinner. */
const HOST_ACCOUNT_TIMEOUT_MS = 30_000;

export function createZReportPublisher(kv: KvStore): ZReportPublish {
  async function patchReport(seq: number, patch: Partial<ZReportRecord>): Promise<ZReportRecord | null> {
    const current = useV1Store.getState().zReports;
    const idx = current.findIndex((report) => report.seq === seq);
    if (idx < 0) return null;
    const updated = { ...current[idx]!, ...patch };
    await appendZReport(kv, updated);
    const next = [...current];
    next[idx] = updated;
    useV1Store.setState({ zReports: next });
    return updated;
  }

  /**
   * Move a conflicted report to the next free slot: past every seq this
   * device knows (local records + the lastZSeq cursor) and every seq already
   * claimed on chain (best-effort read — offline falls back to local state,
   * and the publish pre-check still arbitrates). Persists the re-slot and the
   * bumped cursor so the next close-out cannot collide with the new seq.
   */
  async function reslotPastClaims(record: ZReportRecord, groupId: string): Promise<ZReportRecord> {
    let chainMax = 0;
    try {
      chainMax = await highestClaimedReportSeq(groupId);
    } catch (caught) {
      console.warn("[reports] claimed-seqs read failed — re-slotting from local state only", caught);
    }
    const { zReports, reportState } = useV1Store.getState();
    let maxKnown = Math.max(chainMax, reportState.lastZSeq, record.seq);
    for (const z of zReports) if (z.seq > maxKnown) maxKnown = z.seq;
    const nextSeq = maxKnown + 1;

    // The old attempt's upload embedded the old seq — never trust it at the new slot.
    const rebased: ZReportRecord = { ...record, seq: nextSeq, publishState: "pending" };
    delete rebased.lastAttemptCid;
    await reslotZReport(kv, record.seq, rebased);
    const nextState: ReportState = { ...reportState, lastZSeq: Math.max(reportState.lastZSeq, nextSeq) };
    await saveReportState(kv, nextState);
    useV1Store.setState({
      zReports: useV1Store.getState().zReports.map((z) => (z.seq === record.seq ? rebased : z)),
      reportState: nextState,
    });
    return rebased;
  }

  return async (seq, onStatus) => {
    console.info(`[reports] publish: requested for seq ${seq}`);
    const creds = loadSavedCreds();
    if (creds.groupId === "" || creds.passkey === "") {
      throw new Error("No unlock credentials available — re-unlock to publish reports.");
    }
    let record = useV1Store.getState().zReports.find((report) => report.seq === seq);
    if (!record) throw new Error(`Z report seq ${seq} not found.`);
    if (record.publishState === "published") {
      console.info(`[reports] publish: seq ${seq} already published (cid ${record.cid ?? "?"})`);
      return record;
    }

    console.info("[reports] publish: resolving host product account…");
    const account = await withTimeout(
      resolveHostProductAccount(envConfig.host.productDotNs, envConfig.host.productDerivationIndex),
      HOST_ACCOUNT_TIMEOUT_MS,
      "host product account resolution",
    );
    console.info(`[reports] publish: host product account → ${account.kind}`);
    if (account.kind !== "ready" || account.publicKey == null) {
      throw new Error(account.message ?? "Sign in to the Polkadot host to publish reports.");
    }
    const { signer, walletAddress } = getProductAccountSigner(
      envConfig.host.productDotNs,
      envConfig.host.productDerivationIndex,
      account.publicKey,
    );

    for (let rebases = 0; ; ) {
      const attemptSeq = record.seq;
      console.info(`[reports] publish: attempt at slot seq ${attemptSeq} (re-slots so far: ${rebases})`);
      try {
        const { cid } = await publishZReport({
          groupId: creds.groupId,
          record,
          passkey: creds.passkey,
          signer,
          walletAddress,
          onStatus,
          lastAttemptCid: record.lastAttemptCid,
          onPreimageUploaded: async (attemptCid) => {
            record = (await patchReport(attemptSeq, { lastAttemptCid: attemptCid })) ?? record;
          },
        });
        console.info(`[reports] publish: seq ${attemptSeq} confirmed on-chain (cid ${cid})`);
        return (
          (await patchReport(attemptSeq, { publishState: "published", cid })) ?? { ...record, publishState: "published", cid }
        );
      } catch (caught) {
        if (caught instanceof ReportConflictError) {
          if (rebases >= MAX_SLOT_REBASES) {
            await patchReport(attemptSeq, { publishState: "conflict" });
            throw new Error(
              `Couldn't claim a free on-chain slot after ${MAX_SLOT_REBASES + 1} attempts — ` +
                "another writer keeps taking the next report number. Retry to move the report again.",
              { cause: caught },
            );
          }
          rebases += 1;
          console.warn(`[reports] publish: slot ${attemptSeq} conflicted — re-slotting (${rebases}/${MAX_SLOT_REBASES})`, caught);
          record = await reslotPastClaims(record, creds.groupId);
          console.info(`[reports] publish: re-slotted seq ${attemptSeq} → ${record.seq}`);
          continue;
        }
        if (isTransientChainError(caught)) {
          console.warn(`[reports] publish: transient chain error at seq ${attemptSeq}`, caught);
          throw new Error(
            "The chain connection dropped mid-publish. The report stays pending — " +
              "press Publish to retry; an already-landed upload is detected and reused.",
            { cause: caught },
          );
        }
        console.error(`[reports] publish: failed at seq ${attemptSeq}`, caught);
        throw caught;
      }
    }
  };
}

/**
 * Connection-level failures (vs signer rejections / dispatch errors). A host
 * bridge reconnect surfaces as polkadot-api's `RpcError: Internal error`;
 * raw WS drops as WebSocket/disconnect messages.
 */
function isTransientChainError(caught: unknown): boolean {
  if (!(caught instanceof Error)) return false;
  if (caught.name === "RpcError") return true;
  return /internal error|websocket|disconnected|connection (lost|closed)/i.test(caught.message);
}
