// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Engine-side Z-report publish orchestration: resolve the unlock creds + a
 * host signer, push the encrypted report on-chain via `publishZReport`, and
 * persist the resulting publish state (published / conflict) back into KV +
 * the v1 store. Failures other than a conflict leave the report `pending`
 * for a manual retry from the Reports screen.
 */
import { envConfig } from "@/config.ts";
import { loadSavedCreds } from "@/app/unlock-creds.ts";
import { getProductAccountSigner, resolveHostProductAccount } from "@/shared/api/host/accounts.ts";
import type { TxStatus } from "@/shared/api/contracts/watch-transaction.ts";
import type { KvStore } from "@/shared/utils/kv-store.ts";
import { appendZReport } from "@/features/v1/api/persistence.ts";
import type { ZReportPublishState } from "@/features/v1/types.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";
import { publishZReport, ReportConflictError } from "./report-storage.ts";

export type ZReportPublish = (seq: number, onStatus?: (status: TxStatus) => void) => Promise<void>;

export function createZReportPublisher(kv: KvStore): ZReportPublish {
  async function persistPublishState(
    seq: number,
    publishState: ZReportPublishState,
    cid?: string,
  ): Promise<void> {
    const current = useV1Store.getState().zReports;
    const idx = current.findIndex((report) => report.seq === seq);
    if (idx < 0) return;
    const updated = { ...current[idx]!, publishState, ...(cid !== undefined ? { cid } : {}) };
    await appendZReport(kv, updated);
    const next = [...current];
    next[idx] = updated;
    useV1Store.setState({ zReports: next });
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
      });
      await persistPublishState(seq, "published", cid);
    } catch (caught) {
      if (caught instanceof ReportConflictError) {
        await persistPublishState(seq, "conflict");
      }
      throw caught;
    }
  };
}
