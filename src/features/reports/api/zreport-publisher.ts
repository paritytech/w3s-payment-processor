// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { envConfig } from "@/config.ts";
import { loadSavedCreds } from "@/app/unlock-creds.ts";
import { getProductAccountSigner, resolveHostProductAccount } from "@/shared/api/host/accounts.ts";
import type { TxStatus } from "@/shared/api/contracts/watch-transaction.ts";
import type { KvStore } from "@/shared/utils/kv-store.ts";
import { appendZReport } from "@/features/v1/api/persistence.ts";
import type { ZReportRecord } from "@/features/v1/types.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";
import { publishZReport, ReportConflictError } from "./report-storage.ts";

export type ZReportPublish = (seq: number, onStatus?: (status: TxStatus) => void) => Promise<void>;

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

  return async (seq, onStatus) => {
    const creds = loadSavedCreds();
    if (creds.groupId === "" || creds.passkey === "") {
      throw new Error("No unlock credentials available — re-unlock to publish reports.");
    }
    const record = useV1Store.getState().zReports.find((report) => report.seq === seq);
    if (!record) throw new Error(`Z report seq ${seq} not found.`);
    if (record.publishState === "published") return;

    const account = await resolveHostProductAccount(
      envConfig.host.productDotNs,
      envConfig.host.productDerivationIndex,
    );
    if (account.kind !== "ready" || account.publicKey == null) {
      throw new Error(account.message ?? "Sign in to the Polkadot host to publish reports.");
    }
    const { signer, walletAddress } = getProductAccountSigner(
      envConfig.host.productDotNs,
      envConfig.host.productDerivationIndex,
      account.publicKey,
    );

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
          await patchReport(seq, { lastAttemptCid: attemptCid });
        },
      });
      await patchReport(seq, { publishState: "published", cid });
    } catch (caught) {
      if (caught instanceof ReportConflictError) {
        await patchReport(seq, { publishState: "conflict" });
        throw caught;
      }
      if (isTransientChainError(caught)) {
        throw new Error(
          "The chain connection dropped mid-publish. The report stays pending — " +
            "press Publish to retry; an already-landed upload is detected and reused.",
          { cause: caught },
        );
      }
      throw caught;
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
