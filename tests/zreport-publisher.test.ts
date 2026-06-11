/**
 * Publish orchestration: conflict → re-slot → retry. `publishZReport` and the
 * chain seq read are mocked; the real store, memory KV, and persistence run,
 * so re-slotting is verified end-to-end (store, index, cursor, reload).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { publishZReportMock, highestClaimedSeqMock } = vi.hoisted(() => ({
  publishZReportMock: vi.fn(),
  highestClaimedSeqMock: vi.fn(),
}));

vi.mock("@/features/reports/api/report-storage.ts", () => {
  class ReportConflictError extends Error {
    override readonly name = "ReportConflictError";
  }
  return {
    ReportConflictError,
    publishZReport: (...args: unknown[]) => publishZReportMock(...args),
    highestClaimedReportSeq: (...args: unknown[]) => highestClaimedSeqMock(...args),
  };
});
vi.mock("@/app/unlock-creds.ts", () => ({
  loadSavedCreds: () => ({ groupId: "funkhaus-zola", passkey: "pw" }),
}));
vi.mock("@/shared/api/host/accounts.ts", () => ({
  resolveHostProductAccount: async () => ({ kind: "ready", publicKey: new Uint8Array(32) }),
  getProductAccountSigner: () => ({ signer: {}, walletAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" }),
}));

import { createZReportPublisher } from "@/features/reports/api/zreport-publisher.ts";
import { ReportConflictError } from "@/features/reports/api/report-storage.ts";
import { appendZReport, loadReportState, loadZReports, saveReportState } from "@/features/v1/api/persistence.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";
import type { ZReportRecord } from "@/features/v1/types.ts";
import { createMemoryKvStore, type KvStore } from "@/shared/utils/kv-store.ts";

function zReport(seq: number, patch: Partial<ZReportRecord> = {}): ZReportRecord {
  return {
    seq,
    fromBlock: 1,
    toBlock: 100,
    lines: [],
    grandTotalPlanck: "0",
    count: 0,
    payments: [],
    committedAtMs: seq * 1000,
    source: "v1",
    publishState: "pending",
    ...patch,
  };
}

async function seed(kv: KvStore, reports: ZReportRecord[], lastZSeq: number): Promise<void> {
  for (const record of reports) await appendZReport(kv, record);
  const reportState = { periodStartBlock: 0, lastZSeq };
  await saveReportState(kv, reportState);
  useV1Store.setState({ zReports: reports, reportState });
}

type PublishOpts = {
  record: ZReportRecord;
  lastAttemptCid?: string;
  onPreimageUploaded?: (cid: string) => Promise<void>;
};

function conflict(): ReportConflictError {
  return new ReportConflictError("slot already holds a foreign cid");
}

beforeEach(() => {
  publishZReportMock.mockReset();
  highestClaimedSeqMock.mockReset();
  useV1Store.setState({ zReports: [], reportState: { periodStartBlock: 0, lastZSeq: 0 } });
});

describe("createZReportPublisher", () => {
  it("re-slots a conflicted report past chain claims and publishes under the new seq", async () => {
    const backing = new Map<string, string>();
    const kv = createMemoryKvStore(backing);
    await seed(kv, [zReport(5, { publishState: "conflict", lastAttemptCid: "bafkOldAttempt" })], 5);
    highestClaimedSeqMock.mockResolvedValue(6);
    publishZReportMock
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ cid: "bafkFresh", size: 42 });

    const published = await createZReportPublisher(kv)(5);

    expect(published.seq).toBe(7);
    expect(published.publishState).toBe("published");
    expect(published.cid).toBe("bafkFresh");

    expect(publishZReportMock).toHaveBeenCalledTimes(2);
    const retry = publishZReportMock.mock.calls[1]![0] as PublishOpts;
    expect(retry.record.seq).toBe(7);
    expect(retry.record.lastAttemptCid).toBeUndefined();
    expect(retry.lastAttemptCid).toBeUndefined();

    const { zReports, reportState } = useV1Store.getState();
    expect(zReports.map((z) => z.seq)).toEqual([7]);
    expect(reportState.lastZSeq).toBe(7);

    const reloadedKv = createMemoryKvStore(backing);
    expect((await loadZReports(reloadedKv)).map((z) => z.seq)).toEqual([7]);
    expect((await loadReportState(reloadedKv))!.lastZSeq).toBe(7);
  });

  it("re-slots past locally used seqs when the chain seq read fails", async () => {
    const kv = createMemoryKvStore();
    await seed(kv, [zReport(5, { publishState: "conflict" }), zReport(6)], 6);
    highestClaimedSeqMock.mockRejectedValue(new Error("offline"));
    publishZReportMock
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ cid: "bafkFresh", size: 42 });

    const published = await createZReportPublisher(kv)(5);

    expect(published.seq).toBe(7);
    const { zReports, reportState } = useV1Store.getState();
    expect(zReports.map((z) => z.seq).sort((a, b) => a - b)).toEqual([6, 7]);
    expect(zReports.find((z) => z.seq === 6)!.publishState).toBe("pending");
    expect(reportState.lastZSeq).toBe(7);
  });

  it("marks the report conflicted and gives up once the re-slot budget is spent", async () => {
    const kv = createMemoryKvStore();
    await seed(kv, [zReport(5, { publishState: "conflict" })], 5);
    highestClaimedSeqMock.mockResolvedValue(0);
    publishZReportMock.mockRejectedValue(conflict());

    await expect(createZReportPublisher(kv)(5)).rejects.toThrow(/free on-chain slot/i);

    expect(publishZReportMock).toHaveBeenCalledTimes(5);
    const attemptedSeqs = publishZReportMock.mock.calls.map((call) => (call[0] as PublishOpts).record.seq);
    expect(attemptedSeqs).toEqual([5, 6, 7, 8, 9]);

    const { zReports } = useV1Store.getState();
    expect(zReports).toHaveLength(1);
    expect(zReports[0]!.seq).toBe(9);
    expect(zReports[0]!.publishState).toBe("conflict");
  });

  it("short-circuits an already-published report without touching the chain", async () => {
    const kv = createMemoryKvStore();
    const record = zReport(3, { publishState: "published", cid: "bafkDone" });
    await seed(kv, [record], 3);

    await expect(createZReportPublisher(kv)(3)).resolves.toEqual(record);
    expect(publishZReportMock).not.toHaveBeenCalled();
  });

  it("does not re-slot on non-conflict failures", async () => {
    const kv = createMemoryKvStore();
    await seed(kv, [zReport(5)], 5);
    publishZReportMock.mockRejectedValue(new Error("Signer rejected the transaction"));

    await expect(createZReportPublisher(kv)(5)).rejects.toThrow(/signer rejected/i);

    expect(publishZReportMock).toHaveBeenCalledTimes(1);
    expect(highestClaimedSeqMock).not.toHaveBeenCalled();
    const { zReports } = useV1Store.getState();
    expect(zReports.map((z) => z.seq)).toEqual([5]);
    expect(zReports[0]!.publishState).toBe("pending");
  });

  it("records the attempt cid under the current seq during publish", async () => {
    const kv = createMemoryKvStore();
    await seed(kv, [zReport(5)], 5);
    publishZReportMock.mockImplementation(async (opts: PublishOpts) => {
      await opts.onPreimageUploaded?.("bafkAttempt");
      return { cid: "bafkAttempt", size: 7 };
    });

    await createZReportPublisher(kv)(5);

    const stored = (await loadZReports(kv)).find((z) => z.seq === 5)!;
    expect(stored.lastAttemptCid).toBe("bafkAttempt");
    expect(stored.publishState).toBe("published");
  });
});
