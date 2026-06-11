/**
 * Login-time published-report pull. Chain reads are mocked; envelope
 * encryption, CID computation, persistence, and the store run for real, so a
 * pulled report round-trips byte-identically from "published on chain by
 * another device" to a local ZReportRecord.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readContractMock = vi.fn();
const { hostLookupMock } = vi.hoisted(() => ({ hostLookupMock: vi.fn() }));

vi.mock("@/shared/api/contracts/read.ts", () => ({
  readContract: (...args: unknown[]) => readContractMock(...args),
}));
vi.mock("@/shared/api/client.ts", () => ({ mainChainClient: () => ({}) }));
vi.mock("@/app/unlock-creds.ts", () => ({
  loadSavedCreds: () => ({ groupId: "funkhaus-zola", passkey: "pw" }),
}));
vi.mock("@/shared/api/host/host-api.ts", () => ({
  preimageManager: { lookup: hostLookupMock },
  hostLocalStorage: {},
}));

import { syncPublishedReports } from "@/features/reports/api/report-sync.ts";
import type { ProcessorReportDoc } from "@/features/reports/api/report-doc.ts";
import { loadReportState, loadZReports } from "@/features/v1/api/persistence.ts";
import { useV1Store } from "@/features/v1/store/useV1Store.ts";
import type { ZReportRecord } from "@/features/v1/types.ts";
import { createMemoryKvStore, type KvStore } from "@/shared/utils/kv-store.ts";
import { encryptCredentialEnvelope } from "@/shared/utils/wire/credential-envelope.ts";
import { calculateBulletinCidObject } from "@/shared/utils/wire/cid.ts";

const encoder = new TextEncoder();

function makeDoc(seq: number, payments: ProcessorReportDoc["payments"]): ProcessorReportDoc {
  let total = 0n;
  for (const payment of payments) total += BigInt(payment.amountPlanck);
  return {
    format: "w3s-processor-report",
    version: 1,
    kind: "z",
    groupId: "funkhaus-zola",
    token: { symbol: "USD", decimals: 6 },
    generatedAtMs: 1_718_000_000_000 + seq,
    seq,
    fromBlock: 100 * seq,
    toBlock: 100 * seq + 50,
    lines: [{ terminalId: "till-1", payoutHex: "0xabc", totalPlanck: total.toString(), count: payments.length }],
    grandTotalPlanck: total.toString(),
    count: payments.length,
    payments,
  };
}

interface PublishedReport {
  bytes: Uint8Array;
  cid: string;
  key: `0x${string}`;
}

async function publish(doc: ProcessorReportDoc, passkey = "pw"): Promise<PublishedReport> {
  const envelope = await encryptCredentialEnvelope(encoder.encode(JSON.stringify(doc)), passkey, 100_000);
  const bytes = encoder.encode(JSON.stringify(envelope));
  const cidObj = calculateBulletinCidObject(bytes);
  let key = "0x";
  for (const byte of cidObj.multihash.digest) key += byte.toString(16).padStart(2, "0");
  return { bytes, cid: cidObj.toString(), key: key as `0x${string}` };
}

function mockChain(seqs: number[], slots: Map<number, { cid: string; size: number }>): void {
  readContractMock.mockImplementation(
    (_client: unknown, opts: { functionName: string; args: readonly unknown[] }) => {
      if (opts.functionName === "getProcessorReportSeqs") {
        return Promise.resolve(seqs.map((seq) => BigInt(seq)));
      }
      const seq = Number(opts.args[1]);
      const slot = slots.get(seq);
      if (!slot) {
        return Promise.resolve([{ seq: BigInt(seq), cid: "", size: 0, committedAt: 0n, exists: false }]);
      }
      return Promise.resolve([{ seq: BigInt(seq), cid: slot.cid, size: slot.size, committedAt: 1n, exists: true }]);
    },
  );
}

function lookupFrom(reports: readonly PublishedReport[]): (key: `0x${string}`) => Promise<Uint8Array | null> {
  const byKey = new Map(reports.map((report) => [report.key, report.bytes]));
  return (key) => Promise.resolve(byKey.get(key) ?? null);
}

function pendingLocal(seq: number, patch: Partial<ZReportRecord> = {}): ZReportRecord {
  return {
    seq,
    committedAtMs: 1_717_000_000_000,
    source: "v1",
    publishState: "pending",
    fromBlock: 10,
    toBlock: 20,
    lines: [],
    grandTotalPlanck: "0",
    count: 0,
    payments: [],
    ...patch,
  };
}

let kv: KvStore;

beforeEach(() => {
  readContractMock.mockReset();
  hostLookupMock.mockReset();
  kv = createMemoryKvStore();
  useV1Store.setState({
    zReports: [],
    reportState: { periodStartBlock: 0, lastZSeq: 0 },
    fiscalHydrated: true,
  });
});

describe("syncPublishedReports", () => {
  it("pulls reports published by other devices into the store and KV, then re-runs as a no-op", async () => {
    const v1Doc = makeDoc(1, [
      { paymentId: "p1", terminalId: "till-1", amountPlanck: "5000000", blockNumber: 120, observedAtMs: 1, amount: "5" },
    ]);
    const coinDoc = makeDoc(2, [
      { paymentId: "p2", terminalId: "till-1", amountPlanck: "3000000", observedAtMs: 2, amount: "3" },
    ]);
    const published = [await publish(v1Doc), await publish(coinDoc)];
    mockChain(
      [1, 2],
      new Map([
        [1, { cid: published[0]!.cid, size: published[0]!.bytes.length }],
        [2, { cid: published[1]!.cid, size: published[1]!.bytes.length }],
      ]),
    );

    const changed = await syncPublishedReports(kv, { inHost: () => true, lookupPreimage: lookupFrom(published) });

    expect(changed).toBe(2);
    const { zReports, reportState } = useV1Store.getState();
    expect(zReports.map((z) => z.seq)).toEqual([1, 2]);
    expect(zReports.every((z) => z.publishState === "published")).toBe(true);
    expect(zReports[0]).toMatchObject({ cid: published[0]!.cid, source: "v1", grandTotalPlanck: "5000000" });
    expect(zReports[1]).toMatchObject({ cid: published[1]!.cid, source: "v2", grandTotalPlanck: "3000000" });
    expect(zReports[0]!.payments).toEqual([
      { paymentId: "p1", terminalId: "till-1", amountPlanck: "5000000", blockNumber: 120, observedAtMs: 1 },
    ]);
    expect(reportState.lastZSeq).toBe(2);
    expect(reportState.periodStartBlock).toBe(251);

    expect((await loadZReports(kv)).map((z) => z.seq)).toEqual([1, 2]);
    expect((await loadReportState(kv))?.lastZSeq).toBe(2);

    readContractMock.mockClear();
    mockChain([1, 2], new Map());
    const rerun = await syncPublishedReports(kv, { inHost: () => true, lookupPreimage: lookupFrom([]) });
    expect(rerun).toBe(0);
    const slotReads = readContractMock.mock.calls.filter(
      ([, opts]) => (opts as { functionName: string }).functionName === "getProcessorReport",
    );
    expect(slotReads).toHaveLength(0);
  });

  it("flips a pending local report to published when its earlier upload landed", async () => {
    const landedCid = (await publish(makeDoc(1, []))).cid;
    useV1Store.setState({ zReports: [pendingLocal(1, { lastAttemptCid: landedCid })] });
    mockChain([1], new Map([[1, { cid: landedCid, size: 10 }]]));
    const lookup = vi.fn();

    const changed = await syncPublishedReports(kv, { inHost: () => true, lookupPreimage: lookup });

    expect(changed).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
    const record = useV1Store.getState().zReports.find((z) => z.seq === 1);
    expect(record).toMatchObject({ publishState: "published", cid: landedCid });
    expect((await loadZReports(kv))[0]).toMatchObject({ publishState: "published", cid: landedCid });
  });

  it("leaves a different local report alone when its seq is claimed by a foreign cid", async () => {
    useV1Store.setState({ zReports: [pendingLocal(1)] });
    const foreignCid = calculateBulletinCidObject(encoder.encode("foreign")).toString();
    mockChain([1], new Map([[1, { cid: foreignCid, size: 7 }]]));

    const changed = await syncPublishedReports(kv, {
      inHost: () => true,
      lookupPreimage: () => Promise.resolve(null),
    });

    expect(changed).toBe(0);
    expect(useV1Store.getState().zReports[0]).toMatchObject({ seq: 1, publishState: "pending" });
    expect(useV1Store.getState().reportState.lastZSeq).toBe(1);
  });

  it("skips undecryptable reports but still advances the seq cursor", async () => {
    const foreign = await publish(makeDoc(1, []), "someone-elses-passkey");
    mockChain([1], new Map([[1, { cid: foreign.cid, size: foreign.bytes.length }]]));

    const changed = await syncPublishedReports(kv, { inHost: () => true, lookupPreimage: lookupFrom([foreign]) });

    expect(changed).toBe(0);
    expect(useV1Store.getState().zReports).toHaveLength(0);
    expect(useV1Store.getState().reportState.lastZSeq).toBe(1);
    expect((await loadReportState(kv))?.lastZSeq).toBe(1);
  });

  it("waits through the host's null pushes until the Bulletin fetch delivers the preimage", async () => {
    const doc = makeDoc(1, [
      { paymentId: "p1", terminalId: "till-1", amountPlanck: "5000000", blockNumber: 120, observedAtMs: 1, amount: "5" },
    ]);
    const published = await publish(doc);
    mockChain([1], new Map([[1, { cid: published.cid, size: published.bytes.length }]]));

    const unsubscribe = vi.fn();
    hostLookupMock.mockImplementation((key: string, callback: (preimage: Uint8Array | null) => void) => {
      expect(key).toBe(published.key);
      callback(null);
      setTimeout(() => callback(published.bytes), 1);
      return { unsubscribe, onInterrupt: vi.fn() };
    });

    const changed = await syncPublishedReports(kv, { inHost: () => true });

    expect(changed).toBe(1);
    expect(useV1Store.getState().zReports[0]).toMatchObject({ seq: 1, publishState: "published", cid: published.cid });
    expect(unsubscribe).toHaveBeenCalled();
  });
});
